'use strict';
// Partially finished todo app for demo purposes. Adding and persistence work,
// but deleting is not implemented and the empty-title error text is wrong.
// Expected: 3 of 5 example tests pass (60%).
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = Number(process.env.PORT || 3000);
const DB = process.env.TODO_DB || path.join('/tmp', 'todos.json');

function load() {
  try {
    return JSON.parse(fs.readFileSync(DB, 'utf8'));
  } catch {
    return { nextId: 1, todos: [] };
  }
}

function save(db) {
  fs.writeFileSync(DB, JSON.stringify(db));
}

function page(db, error) {
  const items = db.todos
    .map((t) => `<li data-id="${t.id}"><span>${escapeHtml(t.title)}</span></li>`)
    .join('');
  return `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>Todos</title></head>
<body>
  <h1>Todos</h1>
  <form method="post" action="/todos">
    <label for="title">What needs to be done?</label>
    <input id="title" name="title" type="text">
    <button type="submit">Add</button>
  </form>
  ${error ? `<p role="alert">${error}</p>` : ''}
  <ul>${items}</ul>
</body>
</html>`;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

function readBody(req) {
  return new Promise((resolve) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => resolve(new URLSearchParams(body)));
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const db = load();

  if (req.method === 'GET' && url.pathname === '/') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(page(db));
    return;
  }
  if (req.method === 'POST' && url.pathname === '/todos') {
    const form = await readBody(req);
    const title = (form.get('title') || '').trim();
    if (!title) {
      res.writeHead(422, { 'content-type': 'text/html; charset=utf-8' });
      res.end(page(db, 'Required'));
      return;
    }
    db.todos.push({ id: db.nextId++, title });
    save(db);
    res.writeHead(303, { location: '/' });
    res.end();
    return;
  }
  res.writeHead(404, { 'content-type': 'text/plain' });
  res.end('not found');
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`partial todo app listening on ${PORT}`);
});
