// Terminal control for a running shellnote server. Processes live in the
// server's memory (and its history), so the CLI is a thin HTTP client rather
// than a second executor: that way a block started here shows up in the web UI
// and vice versa, and --kill/--watch work on runs started from either side.
const http = require('http');

const HELP = `shellnote - notes you can run

Usage:
  shellnote                             start the web server
  shellnote --list note                 list notes
  shellnote <note-name>                 show a note (blocks are numbered)
  shellnote --run <note-name> <block>   run a block, stream its output
  shellnote --list process              list runs (running first)
  shellnote --watch <process-id>        follow a run's output until it ends
  shellnote --kill <process-id>         kill a running process
  shellnote --restart <process-id>      kill it (if running), run the same block again, watch the new run

Options:
  --detach     with --run/--restart: print the process id and return immediately
  --port <n>   server port (default: $PORT or 4488)

<note-name> is the file name with or without ".md", or the note title (case-insensitive).
<block> is the number shown by "shellnote <note-name>" (starts at 0).
<process-id> may be a unique prefix of the id.
These commands need the server running ("npx klambox shellnote" in another terminal).
Exit code of --run/--watch is the process's own exit code.`;

function parseArgs(argv) {
  const flags = { port: process.env.PORT || 4488 };
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--port') flags.port = argv[++i];
    else if (a === '--detach') flags.detach = true;
    else if (a === '--help' || a === '-h') flags.help = true;
    else if (['--list', '--run', '--kill', '--watch', '--restart'].includes(a)) flags.cmd = a.slice(2);
    else rest.push(a);
  }
  return { flags, rest };
}

function request(port, method, path, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const req = http.request(
      { host: '127.0.0.1', port, method, path, headers: data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {} },
      (res) => {
        let text = '';
        res.on('data', (c) => (text += c));
        res.on('end', () => {
          let json = null;
          try { json = JSON.parse(text); } catch { /* not json */ }
          if (res.statusCode >= 400) return reject(new Error((json && json.error) || `HTTP ${res.statusCode}`));
          resolve(json);
        });
      },
    );
    req.on('error', (err) => {
      if (err.code === 'ECONNREFUSED') reject(new Error(`shellnote server is not running on port ${port}. Start it with: npx klambox shellnote`));
      else reject(err);
    });
    if (data) req.write(data);
    req.end();
  });
}

// "deploy", "deploy.md" and the note's "# Title" all find the same note; an
// ambiguous match lists the candidates instead of guessing which one to run.
async function resolveNote(port, name) {
  const notes = await request(port, 'GET', '/api/notes');
  const q = name.toLowerCase().replace(/\.md$/, '');
  const stem = (n) => n.file.toLowerCase().replace(/\.md$/, '');
  let hits = notes.filter((n) => stem(n) === q);
  if (!hits.length) hits = notes.filter((n) => stem(n).split('/').pop() === q);
  if (!hits.length) hits = notes.filter((n) => stem(n).includes(q));
  if (hits.length === 1) return hits[0].file;
  if (!hits.length) throw new Error(`No note matches "${name}". Try: shellnote --list note`);
  throw new Error(`"${name}" matches several notes:\n  ${hits.map((n) => n.file).join('\n  ')}`);
}

async function resolveProcess(port, id) {
  const list = await request(port, 'GET', '/api/executions');
  const hits = list.filter((e) => e.execId === id || e.execId.startsWith(id));
  if (hits.length === 1) return hits[0];
  if (!hits.length) throw new Error(`No process matches "${id}". Try: shellnote --list process`);
  throw new Error(`"${id}" matches ${hits.length} processes; use more characters.`);
}

function ago(ms) {
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

function table(rows) {
  const widths = rows[0].map((_, c) => Math.max(...rows.map((r) => String(r[c]).length)));
  for (const r of rows) console.log(r.map((v, c) => String(v).padEnd(widths[c])).join('  ').trimEnd());
}

async function listNotes(port) {
  const notes = await request(port, 'GET', '/api/notes');
  if (!notes.length) return console.log('No notes in the current notes folder.');
  for (const n of notes) console.log(`${n.starred ? '*' : ' '} ${n.file}`);
}

async function showNote(port, name) {
  const file = await resolveNote(port, name);
  const note = await request(port, 'GET', '/api/notes/' + encodeURIComponent(file));
  console.log(`# ${note.title}  (${file})\n`);
  for (const item of note.items) {
    if (item.type === 'prose') console.log(item.text.replace(/\n+$/, '') + '\n');
    else console.log(`[block ${item.index}] ${item.shell}\n${item.code}\n`);
  }
}

async function listProcesses(port) {
  const list = await request(port, 'GET', '/api/executions');
  if (!list.length) return console.log('No processes yet.');
  const rank = (e) => (e.status === 'running' ? 0 : 1); // running first, then newest (server order)
  list.sort((a, b) => rank(a) - rank(b));
  table([
    ['ID', 'STATUS', 'PID', 'STARTED', 'NOTE#BLOCK'],
    ...list.map((e) => [e.execId.slice(0, 8), e.status + (e.exitCode ? ` (${e.exitCode})` : ''), e.pid ?? '-', ago(e.startedAt), `${e.noteFile || '?'}#${e.blockIndex ?? '?'}`]),
  ]);
}

// Prints the run's output as it arrives and resolves with its exit code.
// Ctrl+C only stops watching: the process belongs to the server, and killing
// it as a side effect of closing a terminal would be a nasty surprise.
function watch(port, execId) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port, path: `/api/executions/${execId}/stream` }, (res) => {
      if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode}`));
      res.setEncoding('utf8');
      let buf = '';
      res.on('data', (d) => {
        buf += d;
        let i;
        while ((i = buf.indexOf('\n\n')) !== -1) {
          const frame = buf.slice(0, i);
          buf = buf.slice(i + 2);
          const isDone = frame.startsWith('event: done');
          const payload = JSON.parse(frame.split('\n').find((l) => l.startsWith('data: ')).slice(6));
          if (isDone) {
            req.destroy();
            if (payload.status === 'killed') process.stderr.write('\n[killed]\n');
            return resolve(payload.status === 'success' ? 0 : payload.exitCode || 1);
          }
          process.stdout.write(payload.snapshot ?? payload.chunk ?? '');
        }
      });
      res.on('end', () => resolve(0));
    });
    req.on('error', (err) => (err.code === 'ECONNRESET' ? resolve(0) : reject(err)));
  });
}

async function findBlock(port, name, blockArg) {
  if (blockArg === undefined || !/^\d+$/.test(String(blockArg))) throw new Error('Usage: shellnote --run <note-name> <block-index>');
  const file = await resolveNote(port, name);
  const note = await request(port, 'GET', '/api/notes/' + encodeURIComponent(file));
  const block = note.items.find((i) => i.type === 'block' && i.index === Number(blockArg));
  if (!block) {
    const last = note.items.filter((i) => i.type === 'block').length - 1;
    throw new Error(`${file} has no block ${blockArg}` + (last >= 0 ? ` (blocks 0-${last})` : ' (it has no runnable blocks)'));
  }
  return { file, note, block };
}

async function startBlock(port, { file, note, block }, detach) {
  const { execId } = await request(port, 'POST', '/api/blocks/run', {
    shell: block.shell, code: block.code, noteFile: file, noteTitle: note.title, blockIndex: block.index,
  });
  if (detach) return console.log(execId.slice(0, 8));
  process.stderr.write(`[process ${execId.slice(0, 8)}]\n`);
  process.exitCode = await watch(port, execId);
}

async function run(port, name, blockArg, detach) {
  return startBlock(port, await findBlock(port, name, blockArg), detach);
}

// Kill, then start the same block again. The block is looked up first so a
// note that has since changed (block gone) fails before anything is killed.
// The new run uses the note's current code, not what the old run was started with.
async function restart(port, idPrefix, detach) {
  const proc = await resolveProcess(port, idPrefix);
  if (!proc.noteFile || proc.blockIndex == null) throw new Error(`Process ${proc.execId.slice(0, 8)} has no note/block to run again.`);
  const meta = await request(port, 'GET', '/api/meta');
  if (proc.notesFolder && proc.notesFolder !== meta.notesFolder) {
    throw new Error(`That run belongs to another notes folder (${proc.notesFolder}); the server has ${meta.notesFolder} open.`);
  }
  const target = await findBlock(port, proc.noteFile, proc.blockIndex);
  if (proc.status === 'running') {
    await request(port, 'POST', `/api/executions/${proc.execId}/kill`);
    process.stderr.write(`[killed ${proc.execId.slice(0, 8)}]\n`);
    // The kill is a signal, not a wait: a server block still holds its port for
    // a moment, so starting the new one at once would hit "address in use".
    for (let i = 0; i < 30 && proc.pid && pidAlive(proc.pid); i++) await new Promise((r) => setTimeout(r, 100));
  }
  return startBlock(port, target, detach);
}

function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

async function main(argv) {
  const { flags, rest } = parseArgs(argv);
  const { port } = flags;
  if (flags.help || (!flags.cmd && !rest.length)) return console.log(HELP);

  if (flags.cmd === 'list') {
    if (rest[0] === 'note' || rest[0] === 'notes') return listNotes(port);
    if (rest[0] === 'process' || rest[0] === 'processes') return listProcesses(port);
    throw new Error('Usage: shellnote --list note|process');
  }
  if (flags.cmd === 'restart') {
    if (!rest[0]) throw new Error('Usage: shellnote --restart <process-id>');
    return restart(port, rest[0], flags.detach);
  }
  if (flags.cmd === 'run') return run(port, rest[0] || '', rest[1], flags.detach);
  if (flags.cmd === 'kill' || flags.cmd === 'watch') {
    if (!rest[0]) throw new Error(`Usage: shellnote --${flags.cmd} <process-id>`);
    const proc = await resolveProcess(port, rest[0]);
    if (flags.cmd === 'watch') {
      process.exitCode = await watch(port, proc.execId);
      return;
    }
    if (proc.status !== 'running') throw new Error(`Process ${proc.execId.slice(0, 8)} is not running (${proc.status}).`);
    await request(port, 'POST', `/api/executions/${proc.execId}/kill`);
    return console.log(`Killed ${proc.execId.slice(0, 8)}`);
  }
  return showNote(port, rest.join(' '));
}

function runCli(argv) {
  // `shellnote --watch id | head` closes the pipe early; that is a normal way to stop, not an error.
  process.stdout.on('error', (err) => { if (err.code === 'EPIPE') process.exit(0); });
  main(argv).catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}

module.exports = { runCli };
