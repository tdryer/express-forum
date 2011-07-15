/**
 * Module dependencies.
 */

var express = require('express');

var app = module.exports = express.createServer();

// TODO: switch to more popular sqlite binding? 
// https://github.com/orlandov/node-sqlite
var sqlite3 = require('sqlite3');
var db = new sqlite3.Database('forum.db');

var forms = require('forms');
var fields = forms.fields;
var validators = forms.validators;

var bcrypt = require('bcrypt');

// Configuration

app.configure(function(){
  app.set('views', __dirname + '/views');
  app.set('view engine', 'jade');
  app.use(express.bodyParser());
  app.use(express.methodOverride());
  app.use(express.cookieParser());
  app.use(express.session({ secret: "keyboard cat" }));
  app.use(app.router);
  app.use(express.static(__dirname + '/public'));
});

app.configure('development', function () {
  app.use(express.errorHandler({ dumpExceptions: true, showStack: true })); 
});

app.configure('production', function () {
  app.use(express.errorHandler()); 
});

// Forms

var login_form = forms.create({
  username: fields.string({required: true}),
  password: fields.password({required: true}),
});

var replyform = forms.create({
  content: fields.string({required: true, widget: forms.widgets.textarea()})
});

var newtopicform = forms.create({
  subject: fields.string({required: true}),
  content: fields.string({required: true, widget: forms.widgets.textarea()})
});

var registrationForm = forms.create({
  username: fields.string({required: true, validators: [
    validators.maxlength(20),
    validateUsernameFree
  ]}),
  password: fields.password({required: true}),
  confirm: fields.password({
    required: true,
    validators: [validators.matchField('password')]
  })
});

function validateUsernameFree(form, field, callback) {
  db.get('SELECT * FROM user WHERE username = ?', field.data, 
         function (err, row) {
    if (row !== undefined) {
      callback('Username already taken.');
    } else {
      callback();
    }
  });
}

// View helpers

app.helpers({
  formattime: function (time) {
    var seconds = timestamp() - time;
    var minutes = Math.floor(seconds / 60);
    var hours = Math.floor(minutes / 60);
    var days = Math.floor(hours / 24);
    if (days > 1) { return days + ' days ago'; }
    else if (days === 1) { return '1 day ago'; }
    else if (hours > 1) { return hours + ' hours ago'; }
    else if (hours === 1) { return '1 hour ago'; }
    else if (minutes > 1) { return minutes + ' minutes ago'; }
    else if (minutes === 1) { return '1 minute ago'; }
    else if (seconds > 1) { return seconds + ' seconds ago'; }
    else { return '1 second ago'; }
  }
});

app.dynamicHelpers({
  is_logged_in: function (req, res) {
    return (req.session.username !== undefined);
  },
  username: function (req, res) {
    return req.session.username;
  },
  flashes: function (req, res) {
    var f = req.flash();
    var msgs = [];
    if (f.error) {
      for (i = 0; i < f.error.length; i++) { msgs.push(f.error[i]); }
    }
    if (f.info) {
      for (i = 0; i < f.info.length; i++) { msgs.push(f.info[i]); }
    }
    return msgs;
  }
});

// Route helpers

function timestamp() {
  var n = new Date();
  return Math.round(n.getTime() / 1000);
}

// posts reply and calls callback(topic_id)
function postReply(topic_id, content, username, callback) {
  db.run('INSERT INTO reply (topic_id, time, content, author) values \
         (?, ?, ?, ?);', topic_id, timestamp(), content, username, 
         function (err) {
    callback(topic_id);
  });
}

// posts topic and calls callback(topic_id)
function postTopic(subject, content, username, callback) {
  db.run('INSERT INTO topic (subject) values (?)', subject, function (err) {
    db.get('SELECT last_insert_rowid()', function (err, row) {
      postReply(row['last_insert_rowid()'], content, username, callback);
    });
  });
}

// wrap a route function with this to cause 403 error if not logged in
function require_login(callback) {
  return function (req, res) {
    if (req.session.username === undefined) {
      res.send('Login required', 403);
    } else {
      callback(req, res);
    }
  };
}

// call a function action(i, callback) for i=(num-1 ... 0)
// each call occurs after the previous one is complete
// callback is called when all action calls are complete
function for_loop(num, action, callback) {
  if (num > 0) {
    action(num - 1, function () {
      for_loop(num - 1, action, callback);
    });
  } else {
    callback();
  }
}

// Routes

app.get('/', function (req, res) {
  //TODO: some better SQL could make this a lot simpler
  db.all('SELECT * FROM topic ORDER BY (SELECT MAX(time) FROM reply WHERE \
         reply.topic_id = topic.topic_id) DESC', {}, function (err, rows) {
    function get_reply_count(num, callback) {
      db.get('SELECT count(*) FROM reply WHERE topic_id = ?', 
             rows[num].topic_id, function (err, row) {
        rows[num].replies = row['count(*)'] - 1;
        callback();
      });
    }
    for_loop(rows.length, get_reply_count, function () {
      function get_last_reply_date(num, callback) {
        db.get('SELECT time FROM reply WHERE topic_id = ? ORDER BY time DESC \
               LIMIT 1', rows[num].topic_id, function (err, row) {
          rows[num].last_reply_date = row.time;
          callback();
        });
      }
      for_loop(rows.length, get_last_reply_date, function () {
        res.render('topics', { topics: rows });
      });
    });
  });
});

app.get('/topic/new', function (req, res) {
  res.render('newtopic', { form: newtopicform.toHTML() });
});

app.post('/topic/new', require_login(function (req, res) {
  newtopicform.handle(req, {
    success: function (form) {
      // post topic
      postTopic(form.data.subject, form.data.content, 
                req.session.username, function (topic_id) {
        req.flash('info', 'New topic posted.');
        res.redirect('/topic/' + topic_id);
      });
    },
    other: function (form) {
      res.render('newtopic', { form: form.toHTML() });
    }
  });
}));

app.get('/topic/:topic_id', topic);

app.post('/topic/:topic_id', require_login(topic));

function topic (req, res) {
  var topic_id = req.params.topic_id;
  db.get('SELECT subject FROM topic WHERE topic_id = ?', topic_id, 
         function (err, row) {
    if (row === undefined) {
      res.send(404);
    } else {
      replyform.handle(req, {
        success: function (form) {
          postReply(topic_id, form.data.content, req.session.username,
                    function () {
            req.flash('info', 'Reply posted.');
            render(replyform);
          });
        },
        other: function (form) {
          // only show form errors if form was submitted
          if (req.method === 'GET') {
            render(replyform);
          } else {
            render(form);
          }
        }
      });
    }
    function render (form) {
      db.all('SELECT * FROM reply WHERE topic_id = ? ORDER BY time', topic_id, 
          function(err, rows){
        res.render('topic', {
          subject: row.subject,
          replies: rows,
          form: form.toHTML()
        });
      });
    }
  });
}

app.get('/login', function (req, res) {
  res.render('login', { form: login_form.toHTML() });
});

app.post('/login', function (req, res) {
  login_form.handle(req, {
    success: function (form) {
      var username = form.data.username;
      var password = form.data.password;
      db.get('SELECT password_hash FROM user WHERE username = ?', username,
             function (err, row) {
        if (row === undefined) {
          // user does not exist
          req.flash('error', 'Incorrect username or password.');
          res.render('login', { form: form.toHTML() });
        } else {
          bcrypt.compare(password, row.password_hash, function (err, success) {
            if (success) {
              // success
              req.session.username = username;
              req.flash('info', 'Login successful.');
              res.redirect('/');
            } else {
              // password incorrect
              req.flash('error', 'Incorrect username or password.');
              res.render('login', { form: form.toHTML() });
            }
          });
        }
      });
    },
    other: function (form) {
      res.render('login', { form: form.toHTML() });
    }
  });
});

app.post('/logout', function (req, res) {
  delete req.session.username;
  req.flash('info', 'You have been logged out.');
  res.redirect('/');
});

app.get('/register', function (req, res) {
  res.render('register', { form: registrationForm.toHTML() });
});

app.post('/register', function (req, res) {
  registrationForm.handle(req, {
    success: function (form) {
      bcrypt.gen_salt(12, function (err, salt) {
        bcrypt.encrypt(form.data.password, salt, function (err, hash) {
          db.run('INSERT INTO user (username, password_hash) values (?, ?)', 
                 form.data.username, hash, function (err) {
            req.flash('info', 'Account created. Login to continue.');
            res.redirect('/login');
          });
        });
      });
    },
    other: function (form) {
      res.render('register', { form: form.toHTML() });
    }
  });
});

app.listen(3000);
console.log("Express server listening on port %d", app.address().port);
