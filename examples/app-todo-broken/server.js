'use strict';
// Deliberately broken todo app for demo purposes:
//   - the submit button is named "Add todo" instead of "Add"
//   - todos live in memory only, so a reload loses them
//   - the empty-title error text is wrong
// Deleting works, and the page heading is correct.
const http = require('http');

const PORT = Number(process.env.PORT || 3000);
const db = { nextId: 1, todos: [] };

function page(error) {
  const items = db.todos
    .map(
      (t) => `<li data-id="${t.id}">
        <span>${t.title}</span>
        <form method="post" action="/todos/${t.id}/delete" style="display:inline">
          <button type="submit">Delete</button>
        </form>
      </li>`
    )
    .join('');
  return `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>Todos</title></head>
<body>
  <h1>Todos</h1>
  <form method="post" action="/todos">
    <label for="title">What needs to be done?</label>
    <input id="title" name="title" type="text">
    <button type="submit">Add todo</button>
  </form>
  ${error ? `<p role="alert">${error}</p>` : ''}
  <ul>${items}</ul>
</body>
</html>`;
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

  if (req.method === 'GET' && url.pathname === '/') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(page());
    return;
  }
  if (req.method === 'POST' && url.pathname === '/todos') {
    const form = await readBody(req);
    const title = (form.get('title') || '').trim();
    if (!title) {
      res.writeHead(422, { 'content-type': 'text/html; charset=utf-8' });
      res.end(page('Required'));
      return;
    }
    db.todos.push({ id: db.nextId++, title });
    res.writeHead(303, { location: '/' });
    res.end();
    return;
  }
  const del = url.pathname.match(/^\/todos\/(\d+)\/delete$/);
  if (req.method === 'POST' && del) {
    db.todos = db.todos.filter((t) => t.id !== Number(del[1]));
    res.writeHead(303, { location: '/' });
    res.end();
    return;
  }
  res.writeHead(404, { 'content-type': 'text/plain' });
  res.end('not found');
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`broken todo app listening on ${PORT}`);
});
