const path = require('path');
const crypto = require('crypto');
const express = require('express');
const ws = require('ws');
const bcrypt = require('bcryptjs');
const sqlite3 = require('sqlite3').verbose();

const DB_FILE = path.join(__dirname, 'securetalk.db');
const db = new sqlite3.Database(DB_FILE);

db.serialize(() => {
  db.run(`CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY, username TEXT UNIQUE, password_hash TEXT)`);
  db.run(`CREATE TABLE IF NOT EXISTS messages (id INTEGER PRIMARY KEY, sender TEXT, receiver TEXT, text TEXT, status TEXT, timestamp INTEGER)`);
});

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
const sessions = new Map();

const createToken = () => crypto.randomBytes(32).toString('hex');

const requireAuth = (req, res, next) => {
  const token = (req.headers.authorization || '').slice(7);
  if (token && sessions.has(token)) {
    req.user = { username: sessions.get(token), token };
    next();
  } else {
    res.status(401).json({ error: 'Authentication required' });
  }
};

app.post('/api/register', (req, res) => {
  const { username, password } = req.body || {};
  if (!username || username.length < 6) return res.status(400).json({ error: 'Username must be at least 6 characters' });
  if (!password || !/^(?=.*[^A-Za-z0-9]).{6,}$/.test(password)) return res.status(400).json({ error: 'Password must be >= 6 characters and contain one special character' });
  db.run(`INSERT INTO users(username, password_hash) VALUES (?, ?)`, [username, bcrypt.hashSync(password, 10)], function(err) {
    if (err) return res.status(409).json({ error: 'Username is already taken' });
    res.status(201).json({ success: true });
  });
});

app.post('/api/login', (req, res) => {
  const { username, password } = req.body || {};
  db.get(`SELECT password_hash FROM users WHERE username = ?`, [username], (err, row) => {
    if (!row || !bcrypt.compareSync(password, row.password_hash)) return res.status(401).json({ error: 'Invalid username or password' });
    const token = createToken();
    sessions.set(token, username);
    res.json({ success: true, username, token });
  });
});

app.post('/api/logout', requireAuth, (req, res) => {
  sessions.delete(req.user.token);
  res.json({ success: true });
});

app.get('/api/users', requireAuth, (req, res) => {
  const onlineUsers = new Set([...clients.values()].map(c => c.username).filter(Boolean));
  db.all(`SELECT username FROM users WHERE username != ? ORDER BY username`, [req.user.username], (err, rows) => {
    if (err) return res.status(500).json({ error: 'Database error' });
    res.json(rows.map(r => ({ username: r.username, online: onlineUsers.has(r.username) })));
  });
});

app.get('/api/history', requireAuth, (req, res) => {
  const withUser = req.query.with || '';
  db.all(`SELECT * FROM messages WHERE (sender = ? AND receiver = ?) OR (sender = ? AND receiver = ?) ORDER BY timestamp ASC`, [req.user.username, withUser, withUser, req.user.username], (err, rows) => {
    if (err) return res.status(500).json({ error: 'Database error' });
    res.json(rows);
  });
});

const server = app.listen(3000, () => console.log('Server is running on http://localhost:3000'));
const wss = new ws.Server({ server });
const clients = new Map();

wss.on('connection', socket => {
  clients.set(socket, { username: null });
  socket.on('message', rawMessage => {
    try {
      const msg = JSON.parse(rawMessage.toString());
      const context = clients.get(socket);
      if (msg.type === 'auth') {
        const username = sessions.get(msg.token);
        if (username) {
          context.username = username;
          socket.send(JSON.stringify({ type: 'authed', username }));
        } else {
          socket.close(1008, 'Invalid token');
        }
      } else if (context.username) {
        if (msg.type === 'send_message') {
          const { to, text, clientId, timestamp } = msg;
          db.run(`INSERT INTO messages(sender, receiver, text, status, timestamp) VALUES (?, ?, ?, ?, ?)`, [context.username, to, text, 'sent', timestamp], function(err) {
            if (err) return;
            let status = 'sent';
            for (const [client, clientContext] of clients.entries()) {
              if (clientContext.username === to && client.readyState === ws.OPEN) {
                client.send(JSON.stringify({ type: 'incoming_message', from: context.username, text, timestamp }));
                status = 'delivered';
                db.run(`UPDATE messages SET status = 'delivered' WHERE id = ?`, [this.lastID]);
                break;
              }
            }
            socket.send(JSON.stringify({ type: 'delivery_update', clientId, id: this.lastID, status }));
          });
        } else if (msg.type === 'mark_read') {
          db.run(`UPDATE messages SET status = 'read' WHERE receiver = ? AND sender = ? AND status != 'read'`, [context.username, msg.with], () => {
            for (const [client, clientContext] of clients.entries()) {
              if (clientContext.username === msg.with) client.send(JSON.stringify({ type: 'read_receipt', by: context.username }));
            }
          });
        }
      }
    } catch (e) {}
  });
  socket.on('close', () => clients.delete(socket));
});