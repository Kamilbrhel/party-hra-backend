const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const { Pool } = require('pg');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const ADMIN_PASSWORD = 'aaaaaa';

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false
});

// Zápis událostí do DB
async function logEvent(category, text) {
  try {
    await pool.query(
      'INSERT INTO game_logs (category, text, created_at) VALUES ($1, $2, NOW())',
      [category, text]
    );
  } catch (err) {
    console.error('Chyba při zápisu do logu:', err);
  }
}

// Inicializace databáze
async function initDb() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS impostor_words (
        id SERIAL PRIMARY KEY,
        word VARCHAR(100) NOT NULL UNIQUE
      );
      CREATE TABLE IF NOT EXISTS truth_or_dare (
        id SERIAL PRIMARY KEY,
        type VARCHAR(10) NOT NULL,
        text TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS who_would (
        id SERIAL PRIMARY KEY,
        text TEXT NOT NULL UNIQUE
      );
      CREATE TABLE IF NOT EXISTS never_have_i (
        id SERIAL PRIMARY KEY,
        text TEXT NOT NULL UNIQUE
      );
      CREATE TABLE IF NOT EXISTS game_logs (
        id SERIAL PRIMARY KEY,
        category VARCHAR(20) NOT NULL,
        text TEXT NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);

    const wordsCount = await pool.query('SELECT COUNT(*) FROM impostor_words');
    if (parseInt(wordsCount.rows[0].count) === 0) {
      await pool.query("INSERT INTO impostor_words (word) VALUES ('Káva'), ('Letiště'), ('Nemocnice'), ('Škola'), ('Fotbal');");
    }

    const todCount = await pool.query('SELECT COUNT(*) FROM truth_or_dare');
    if (parseInt(todCount.rows[0].count) === 0) {
      await pool.query("INSERT INTO truth_or_dare (type, text) VALUES ('truth', 'Jaké je tvoje největší tajemství?'), ('dare', 'Udělej 10 kliků přímo teď.');");
    }

    const whoCount = await pool.query('SELECT COUNT(*) FROM who_would');
    if (parseInt(whoCount.rows[0].count) === 0) {
      await pool.query("INSERT INTO who_would (text) VALUES ('přežil na opuštěném ostrově?'), ('utratil všechny peníze za blbost?'), ('zapomněl na vlastní narozeniny?');");
    }

    const neverCount = await pool.query('SELECT COUNT(*) FROM never_have_i');
    if (parseInt(neverCount.rows[0].count) === 0) {
      await pool.query("INSERT INTO never_have_i (text) VALUES ('dostal pokutu za rychlost.'), ('usnul v kině.'), ('ztratil klíče od domu.');");
    }

    console.log('SQL DB inicializována.');
    await logEvent('GAMES', 'Server byl úspěšně spuštěn.');
  } catch (err) {
    console.error('Chyba při inicializaci SQL DB:', err);
  }
}

initDb();

// Mazání logů starších 12 hodin
setInterval(async () => {
  try {
    await pool.query("DELETE FROM game_logs WHERE created_at < NOW() - INTERVAL '12 hours'");
  } catch (err) {
    console.error('Chyba při mazání starých logů:', err);
  }
}, 60 * 60 * 1000);

function checkAdminAuth(req, res, next) {
  const authHeader = req.headers['x-admin-password'] || req.query.password || req.body.password;
  if (authHeader === ADMIN_PASSWORD) {
    next();
  } else {
    res.status(401).json({ error: 'Neplatné heslo' });
  }
}

// ==========================================
// ADMIN & HIDDEN API
// ==========================================

let riggedQuestions = {}; 

app.get('/api/hidden/info', checkAdminAuth, (req, res) => {
  const roomsInfo = {};
  for (const code in rooms) {
    const room = rooms[code];
    if (room.players && room.players.length > 0) {
      const activePlayer = (room.currentGame === 'truth_or_dare' && room.todPlayerOrder && room.todPlayerOrder.length > 0) 
        ? room.todPlayerOrder[room.currentTurnIndex]?.name 
        : 'Zatím nikdo';

      roomsInfo[code] = {
        players: room.players.map(p => p.name),
        activePlayer: activePlayer,
        rigged: riggedQuestions[code] || null
      };
    }
  }
  res.json({ rooms: roomsInfo });
});

app.post('/api/hidden/rig', checkAdminAuth, (req, res) => {
  const { roomCode, victimPlayer, customText, type } = req.body;
  if (!roomCode || !customText || !victimPlayer) return res.status(400).send('Chybí data');

  riggedQuestions[roomCode] = { victim: victimPlayer, type: type || 'dare', text: customText };
  logEvent('TOD', `🕵️ SKRYTÝ PODVRH: Pro "${victimPlayer}" v ${roomCode}: "${customText}"`);
  res.json({ success: true });
});

app.get('/api/admin/data', checkAdminAuth, async (req, res) => {
  try {
    const words = await pool.query('SELECT * FROM impostor_words ORDER BY id DESC');
    const tod = await pool.query('SELECT * FROM truth_or_dare ORDER BY id DESC');
    const who = await pool.query('SELECT * FROM who_would ORDER BY id DESC');
    const never = await pool.query('SELECT * FROM never_have_i ORDER BY id DESC');
    const logs = await pool.query("SELECT id, category, text, TO_CHAR(created_at, 'HH24:MI:SS') as time_str FROM game_logs ORDER BY id DESC LIMIT 150");
    res.json({ words: words.rows, tod: tod.rows, who: who.rows, never: never.rows, logs: logs.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/admin/bulk-add', checkAdminAuth, async (req, res) => {
  const { table, textInput, type } = req.body;
  if (!table || !textInput) return res.status(400).send('Chybí data');

  const items = textInput.split(';').map(s => s.trim()).filter(s => s.length > 0);
  try {
    for (const text of items) {
      if (table === 'truth_or_dare') {
        await pool.query('INSERT INTO truth_or_dare (type, text) VALUES ($1, $2)', [type || 'truth', text]);
      } else if (table === 'impostor_words') {
        await pool.query('INSERT INTO impostor_words (word) VALUES ($1) ON CONFLICT DO NOTHING', [text]);
      } else if (table === 'who_would') {
        await pool.query('INSERT INTO who_would (text) VALUES ($1) ON CONFLICT DO NOTHING', [text]);
      } else if (table === 'never_have_i') {
        await pool.query('INSERT INTO never_have_i (text) VALUES ($1) ON CONFLICT DO NOTHING', [text]);
      }
    }
    await logEvent('GAMES', `Přidány položky do ${table}: ${items.length} ks`);
    res.json({ success: true, count: items.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/admin/:table/:id', checkAdminAuth, async (req, res) => {
  const { table, id } = req.params;
  const validTables = ['impostor_words', 'truth_or_dare', 'who_would', 'never_have_i'];
  if (!validTables.includes(table)) return res.status(400).send('Neplatná tabulka');

  try {
    await pool.query(`DELETE FROM ${table} WHERE id = $1`, [id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/admin/clear-logs', checkAdminAuth, async (req, res) => {
  try {
    await pool.query('DELETE FROM game_logs');
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// HTML ADMINISTRACE (/admin)
app.get('/admin', (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html lang="cs">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>Párty Hra - Administrace</title>
      <style>
        * { box-sizing: border-box; }
        body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: #0f172a; color: #f8fafc; margin: 0; padding: 15px; }
        .container { max-width: 900px; margin: 0 auto; }
        h1 { color: #38bdf8; text-align: center; font-size: 24px; margin-bottom: 20px; }
        .card { background: #1e293b; padding: 20px; border-radius: 12px; margin-bottom: 20px; box-shadow: 0 4px 6px rgba(0,0,0,0.3); }
        h2 { color: #4ade80; font-size: 18px; margin-top: 0; border-bottom: 1px solid #334155; padding-bottom: 8px; display: flex; justify-content: space-between; align-items: center; }
        input, select, textarea, button { font-size: 16px; padding: 12px; border-radius: 8px; border: 1px solid #334155; background: #0f172a; color: white; width: 100%; margin-bottom: 10px; }
        button { background: #38bdf8; color: #0f172a; font-weight: bold; border: none; cursor: pointer; transition: 0.2s; }
        button:hover { background: #0284c7; color: white; }
        .hint { font-size: 13px; color: #94a3b8; margin-top: -5px; margin-bottom: 10px; }
        #authOverlay { position: fixed; top:0; left:0; width:100%; height:100%; background: #0f172a; display: flex; justify-content: center; align-items: center; z-index: 999; }
        .login-box { background: #1e293b; padding: 30px; border-radius: 12px; width: 90%; max-width: 400px; text-align: center; }
        .list-box { max-height: 200px; overflow-y: auto; margin-top: 10px; }
        .list-item { display: flex; justify-content: space-between; align-items: center; background: #0f172a; padding: 8px 12px; border-radius: 8px; margin-bottom: 6px; border: 1px solid #334155; font-size: 14px; word-break: break-word; }
        .btn-del { background: #ef4444; color: white; border: none; padding: 4px 8px; border-radius: 6px; cursor: pointer; font-size: 12px; width: auto; margin-left: 10px; flex-shrink: 0; margin-bottom: 0; }
        .badge { font-weight: bold; padding: 2px 8px; border-radius: 4px; font-size: 11px; margin-right: 8px; text-transform: uppercase; }
        .badge-truth { background: #3b82f6; color: white; }
        .badge-dare { background: #a855f7; color: white; }
        .log-item { padding: 8px 12px; border-bottom: 1px solid #334155; font-size: 13px; display: flex; gap: 10px; }
        .log-time { color: #64748b; font-family: monospace; }
        .log-cat { font-weight: bold; color: #38bdf8; width: 90px; flex-shrink: 0; }
      </style>
    </head>
    <body>

      <div id="authOverlay">
        <div class="login-box">
          <h2 style="justify-content: center; color: #38bdf8;">🔒 Administrace</h2>
          <p style="color: #94a3b8; font-size: 14px;">Zadejte heslo pro přístup</p>
          <input type="password" id="passInput" value="aaaaaa" placeholder="Heslo admina" onkeydown="if(event.key==='Enter') login()">
          <button onclick="login()">Vstoupit</button>
          <div id="loginError" style="color: #ef4444; margin-top: 10px; font-size: 14px; display: none;">Neplatné heslo!</div>
        </div>
      </div>

      <div class="container" id="mainContent" style="display: none;">
        <h1>⚙️ Správa Databáze & Logy</h1>

        <!-- VKLÁDÁNÍ NOVÝCH DAT -->
        <div class="card">
          <h2>➕ Hromadné Přidávání Otázek / Slov</h2>
          <label>Vyber Hru / Databázi:</label>
          <select id="targetTable" onchange="toggleTodSelect()">
            <option value="impostor_words">🕵️ Impostor - Slova</option>
            <option value="truth_or_dare">🎲 Pravda nebo Úkol</option>
            <option value="who_would">🤔 Kdo by spíš...</option>
            <option value="never_have_i">🍺 Nikdy jsem...</option>
          </select>

          <div id="todTypeBox" style="display: none;">
            <label>Typ:</label>
            <select id="todType">
              <option value="truth">Pravda</option>
              <option value="dare">Úkol</option>
            </select>
          </div>

          <textarea id="bulkInput" rows="3" placeholder="Položka 1; Položka 2; Položka 3"></textarea>
          <div class="hint">Více položek najednou oddělujte středníkem (<b>;</b>).</div>
          <button onclick="sendBulk()">➕ Uložit do Databáze</button>
        </div>

        <!-- LOGY -->
        <div class="card">
          <h2>
            📜 Herní Logy
            <div>
              <button onclick="downloadLogsTxt()" style="background: #059669; width: auto; font-size: 12px; padding: 6px 12px; margin-bottom:0;">📥 Stáhnout TXT</button>
              <button onclick="clearLogs()" style="background: #475569; width: auto; font-size: 12px; padding: 6px 12px; margin-bottom:0;">Smazat Logy</button>
            </div>
          </h2>
          <div id="logsBox" class="list-box" style="max-height: 250px; background: #0f172a; border-radius: 8px; padding: 8px;">
            <i>Načítám logy...</i>
          </div>
        </div>

        <!-- SEZNAMY V DATABÁZI -->
        <div class="card">
          <h2>🕵️ Impostor - Slova</h2>
          <div id="impostorList" class="list-box"><i>Načítám...</i></div>
        </div>

        <div class="card">
          <h2>🎲 Pravda nebo Úkol</h2>
          <div id="todList" class="list-box"><i>Načítám...</i></div>
        </div>

        <div class="card">
          <h2>🤔 Kdo by spíš...</h2>
          <div id="whoList" class="list-box"><i>Načítám...</i></div>
        </div>

        <div class="card">
          <h2>🍺 Nikdy jsem...</h2>
          <div id="neverList" class="list-box"><i>Načítám...</i></div>
        </div>
      </div>

      <script>
        let adminPassword = 'aaaaaa';
        let allLogs = [];

        function toggleTodSelect() {
          const table = document.getElementById('targetTable').value;
          document.getElementById('todTypeBox').style.display = table === 'truth_or_dare' ? 'block' : 'none';
        }

        async function login() {
          const p = document.getElementById('passInput').value;
          adminPassword = p || 'aaaaaa';
          const success = await loadData();
          if (success) {
            document.getElementById('authOverlay').style.display = 'none';
            document.getElementById('mainContent').style.display = 'block';
            setInterval(loadData, 4000); // Auto-obnovení dat a logů
          } else {
            document.getElementById('loginError').style.display = 'block';
          }
        }

        async function loadData() {
          try {
            const res = await fetch('/api/admin/data', {
              headers: { 'x-admin-password': adminPassword }
            });
            if (res.status === 401) return false;

            const data = await res.json();
            allLogs = data.logs || [];

            renderList('impostorList', data.words, 'impostor_words', w => w.word);
            renderTodList('todList', data.tod);
            renderList('whoList', data.who, 'who_would', w => w.text);
            renderList('neverList', data.never, 'never_have_i', n => n.text);
            renderLogs();
            return true;
          } catch (e) {
            return false;
          }
        }

        function renderList(elementId, items, table, textExtractor) {
          const box = document.getElementById(elementId);
          if (!items || items.length === 0) {
            box.innerHTML = '<p style="color: #64748b;">Žádná data v databázi.</p>';
            return;
          }
          box.innerHTML = items.map(item => \`
            <div class="list-item">
              <span>\${textExtractor(item)}</span>
              <button class="btn-del" onclick="deleteItem('\${table}', \${item.id})">Smazat</button>
            </div>
          \`).join('');
        }

        function renderTodList(elementId, items) {
          const box = document.getElementById(elementId);
          if (!items || items.length === 0) {
            box.innerHTML = '<p style="color: #64748b;">Žádná data v databázi.</p>';
            return;
          }
          box.innerHTML = items.map(t => \`
            <div class="list-item">
              <div>
                <span class="badge \${t.type === 'truth' ? 'badge-truth' : 'badge-dare'}">\${t.type}</span>
                <span>\${t.text}</span>
              </div>
              <button class="btn-del" onclick="deleteItem('truth_or_dare', \${t.id})">Smazat</button>
            </div>
          \`).join('');
        }

        function renderLogs() {
          const box = document.getElementById('logsBox');
          if (!allLogs || allLogs.length === 0) {
            box.innerHTML = '<div style="color: #64748b; padding: 10px;">Žádné herní logy.</div>';
            return;
          }
          box.innerHTML = allLogs.map(l => \`
            <div class="log-item">
              <span class="log-time">\${l.time_str || ''}</span>
              <span class="log-cat">[\${l.category}]</span>
              <span>\${l.text}</span>
            </div>
          \`).join('');
        }

        async function sendBulk() {
          const table = document.getElementById('targetTable').value;
          const textInput = document.getElementById('bulkInput').value;
          const type = document.getElementById('todType').value;

          if (!textInput) return alert('Zadej text!');

          await fetch('/api/admin/bulk-add', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'x-admin-password': adminPassword },
            body: JSON.stringify({ table, textInput, type })
          });

          document.getElementById('bulkInput').value = '';
          loadData();
        }

        async function deleteItem(table, id) {
          if (confirm('Opravdu smazat tuto položku?')) {
            await fetch(\`/api/admin/\${table}/\${id}\`, {
              method: 'DELETE',
              headers: { 'x-admin-password': adminPassword }
            });
            loadData();
          }
        }

        async function clearLogs() {
          if (confirm('Opravdu vymazat všechny logy?')) {
            await fetch('/api/admin/clear-logs', {
              method: 'POST',
              headers: { 'x-admin-password': adminPassword }
            });
            loadData();
          }
        }

        function downloadLogsTxt() {
          if (allLogs.length === 0) return alert('Žádné logy!');
          let txt = "=== PÁRTY HRA - LOGY ===\\n\\n";
          allLogs.forEach(l => { txt += \`[\${l.time_str}] [\${l.category}] \${l.text}\\n\`; });
          const blob = new Blob([txt], { type: 'text/plain;charset=utf-8;' });
          const a = document.createElement('a');
          a.href = URL.createObjectURL(blob);
          a.download = 'herni_logy.txt';
          a.click();
        }

        login();
      </script>
    </body>
    </html>
  `);
});

// ==========================================
// SOCKET.IO LOBBY A LOGIKA HRY
// ==========================================

const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });
const rooms = {};

io.on('connection', (socket) => {

  socket.on('create_room', () => {
    const roomCode = Math.random().toString(36).substring(2, 6).toUpperCase();
    rooms[roomCode] = { 
      hostId: socket.id, 
      players: [], 
      currentGame: null, 
      currentTurnIndex: 0,
      roundCount: 1,
      secretWord: '',
      impostorCount: 1,
      votes: {},
      whoVotes: {},
      currentWhoQuestion: ''
    };
    socket.join(roomCode);
    socket.emit('room_created', { roomCode });
    logEvent('GAMES', `Vytvořena nová herní místnost: ${roomCode}`);
  });

  socket.on('join_room', ({ roomCode, playerName }) => {
    const room = rooms[roomCode];
    if (!room) return socket.emit('error_msg', 'Místnost neexistuje!');

    const trimmedName = playerName.trim();
    const existingPlayer = room.players.find(p => p.name.toLowerCase() === trimmedName.toLowerCase());

    if (existingPlayer) {
      existingPlayer.id = socket.id;
      socket.join(roomCode);
      socket.emit('joined_successfully', { playerName: existingPlayer.name, roomCode });
      logEvent('PLAYERS', `Hráč "${existingPlayer.name}" se znovu připojil do ${roomCode}`);

      if (room.currentGame === 'who_would') {
        socket.emit('start_who_would_client', { 
          question: room.currentWhoQuestion, 
          players: room.players.map(p => ({ id: p.id, name: p.name })) 
        });
      }
    } else {
      const newPlayer = { id: socket.id, name: trimmedName, role: 'Hráč' };
      room.players.push(newPlayer);
      socket.join(roomCode);

      socket.emit('joined_successfully', { playerName: trimmedName, roomCode });
      io.to(room.hostId).emit('update_players', room.players);
      logEvent('PLAYERS', `Hráč "${trimmedName}" se připojil do ${roomCode}`);
    }
  });

  // --- KDO BY SPÍŠ ---
  socket.on('start_who_would', async ({ roomCode }) => {
    const room = rooms[roomCode];
    if (!room) return;
    room.currentGame = 'who_would';
    logEvent('WHO_WOULD', `Spuštěna hra Kdo by spíš v ${roomCode}`);
    await nextWhoWouldQuestion(roomCode);
  });

  socket.on('next_who_would', async ({ roomCode }) => {
    await nextWhoWouldQuestion(roomCode);
  });

  socket.on('submit_who_vote', ({ roomCode, votedPlayerName }) => {
    const room = rooms[roomCode];
    if (!room) return;

    room.whoVotes[socket.id] = votedPlayerName;

    const voteCounts = {};
    Object.values(room.whoVotes).forEach(name => {
      voteCounts[name] = (voteCounts[name] || 0) + 1;
    });

    logEvent('WHO_WOULD', `Hráč poslal hlas pro: ${votedPlayerName} v ${roomCode}`);

    io.to(room.hostId).emit('update_who_votes', {
      totalVotes: Object.keys(room.whoVotes).length,
      totalPlayers: room.players.length,
      voteCounts: voteCounts
    });
  });

  // --- NIKDY JSEM ---
  socket.on('get_never_have_i', async ({ roomCode }) => {
    try {
      const dbRes = await pool.query('SELECT text FROM never_have_i ORDER BY RANDOM() LIMIT 1');
      const question = dbRes.rows[0]?.text || 'Chyba načtení otázky';
      logEvent('NEVER_HAVE_I', `Zobrazena otázka: "Nikdy jsem ${question}" v ${roomCode}`);
      io.to(socket.id).emit('never_have_i_question', { text: question });
    } catch (e) {
      console.error(e);
    }
  });

  // --- IMPOSTOR ---
  socket.on('start_impostor', async ({ roomCode, impostorCount }) => {
    const room = rooms[roomCode];
    if (!room || room.players.length === 0) return;

    room.currentGame = 'impostor';
    room.impostorCount = Math.min(parseInt(impostorCount) || 1, room.players.length - 1 || 1);
    room.currentTurnIndex = 0;
    room.roundCount = 1;
    room.votes = {};

    try {
      const dbRes = await pool.query('SELECT word FROM impostor_words ORDER BY RANDOM() LIMIT 1');
      room.secretWord = dbRes.rows[0]?.word || 'Káva';

      const shuffledIndices = room.players.map((_, i) => i).sort(() => Math.random() - 0.5);
      const impostorIndices = shuffledIndices.slice(0, room.impostorCount);

      const impostorNames = [];
      room.players.forEach((player, index) => {
        if (impostorIndices.includes(index)) {
          player.role = 'Impostor';
          impostorNames.push(player.name);
        } else {
          player.role = 'Hráč';
        }
      });

      room.currentTurnIndex = Math.floor(Math.random() * room.players.length);

      room.players.forEach((player) => {
        io.to(player.id).emit('assign_role', { 
          game: 'impostor', 
          role: player.role, 
          word: player.role === 'Impostor' ? '???' : room.secretWord 
        });
      });

      sendImpostorTurnState(roomCode);
      logEvent('IMPOSTOR', `Spuštěn Impostor v ${roomCode}. Tajné slovo: "${room.secretWord}", Impostor: ${impostorNames.join(', ')}`);
    } catch (err) { console.error(err); }
  });

  socket.on('next_impostor_turn', ({ roomCode }) => {
    const room = rooms[roomCode];
    if (!room || room.players.length === 0) return;
    room.currentTurnIndex = (room.currentTurnIndex + 1) % room.players.length;
    if (room.currentTurnIndex === 0) room.roundCount++;
    sendImpostorTurnState(roomCode);
  });

  socket.on('start_voting', ({ roomCode }) => {
    const room = rooms[roomCode];
    if (!room) return;
    room.votes = {};
    logEvent('IMPOSTOR', `Spuštěno hlasování Impostora v ${roomCode}`);
    io.to(roomCode).emit('impostor_voting_started', { players: room.players.map(p => ({ id: p.id, name: p.name })) });
  });

  socket.on('submit_vote', ({ roomCode, votedPlayerId }) => {
    const room = rooms[roomCode];
    if (!room) return;
    room.votes[socket.id] = votedPlayerId;
    const voteCounts = {};
    Object.values(room.votes).forEach(targetId => { voteCounts[targetId] = (voteCounts[targetId] || 0) + 1; });
    io.to(room.hostId).emit('update_vote_counts', { totalVotes: Object.keys(room.votes).length, totalPlayers: room.players.length, voteCounts });
  });

  socket.on('reveal_impostor', ({ roomCode }) => {
    const room = rooms[roomCode];
    if (!room) return;
    const impostors = room.players.filter(p => p.role === 'Impostor').map(p => p.name);
    logEvent('IMPOSTOR', `Odhalení v ${roomCode}: Impostor = ${impostors.join(', ')}, Slovo = "${room.secretWord}"`);
    io.to(roomCode).emit('impostor_revealed', {
      impostors: impostors,
      secretWord: room.secretWord
    });
  });

  // --- PRAVDA NEBO ÚKOL ---
  socket.on('start_truth_or_dare', ({ roomCode }) => {
    const room = rooms[roomCode];
    if (!room || room.players.length === 0) return;
    room.currentGame = 'truth_or_dare';
    room.todPlayerOrder = [...room.players].sort(() => Math.random() - 0.5);
    room.currentTurnIndex = 0;
    logEvent('TOD', `Spuštěno Pravda nebo Úkol v ${roomCode}`);
    io.to(room.hostId).emit('game_started', { game: 'Pravda nebo Úkol' });
    sendTodTurnState(roomCode);
  });

  socket.on('tod_choice', async ({ roomCode, choice }) => {
    const room = rooms[roomCode];
    if (!room || !room.todPlayerOrder || room.todPlayerOrder.length === 0) return;

    const activePlayer = room.todPlayerOrder[room.currentTurnIndex];
    let question = '';
    let choiceLabel = choice === 'truth' ? 'PRAVDA' : 'ÚKOL';

    if (riggedQuestions[roomCode] && riggedQuestions[roomCode].victim === activePlayer.name && riggedQuestions[roomCode].type === choice) {
      question = riggedQuestions[roomCode].text;
      delete riggedQuestions[roomCode];
      logEvent('TOD', `😈 Aplikován SKRYTÝ PODVRH pro ${activePlayer.name}: "${question}"`);
    } else {
      try {
        const dbRes = await pool.query('SELECT text FROM truth_or_dare WHERE type = $1 ORDER BY RANDOM() LIMIT 1', [choice]);
        question = dbRes.rows[0]?.text || 'Chyba načtení otázky';
      } catch (err) { console.error(err); }
    }

    logEvent('TOD', `Hráč "${activePlayer.name}" dostal [${choiceLabel}]: "${question}"`);
    io.to(roomCode).emit('tod_question', { playerName: activePlayer.name, type: choiceLabel, text: question });
  });

  socket.on('next_tod_turn', ({ roomCode }) => {
    const room = rooms[roomCode];
    if (!room || !room.todPlayerOrder) return;
    room.currentTurnIndex = (room.currentTurnIndex + 1) % room.todPlayerOrder.length;
    sendTodTurnState(roomCode);
  });

  socket.on('return_to_lobby', ({ roomCode }) => {
    const room = rooms[roomCode];
    if (!room) return;
    room.currentGame = null;
    logEvent('GAMES', `Návrat do lobby v ${roomCode}`);
    io.to(roomCode).emit('back_to_lobby');
  });

  socket.on('disconnect', () => {
    for (const code in rooms) {
      const room = rooms[code];
      const playerIndex = room.players.findIndex(p => p.id === socket.id);
      if (playerIndex !== -1) {
        const disconnectedPlayer = room.players[playerIndex];
        setTimeout(() => {
          if (disconnectedPlayer.id === socket.id) {
            room.players.splice(playerIndex, 1);
            logEvent('PLAYERS', `Hráč "${disconnectedPlayer.name}" opustil ${code}`);
            if (room.players.length === 0) {
              delete rooms[code];
              delete riggedQuestions[code];
            } else {
              io.to(room.hostId).emit('update_players', room.players);
            }
          }
        }, 4000);
        break;
      }
    }
  });
});

async function nextWhoWouldQuestion(roomCode) {
  const room = rooms[roomCode];
  if (!room) return;

  try {
    const dbRes = await pool.query('SELECT text FROM who_would ORDER BY RANDOM() LIMIT 1');
    room.currentWhoQuestion = dbRes.rows[0]?.text || 'Chyba načtení otázky';
    room.whoVotes = {};

    logEvent('WHO_WOULD', `Otázka v ${roomCode}: "Kdo by spíš ${room.currentWhoQuestion}"`);

    io.to(roomCode).emit('start_who_would_client', {
      question: room.currentWhoQuestion,
      players: room.players.map(p => ({ id: p.id, name: p.name }))
    });

    io.to(room.hostId).emit('who_would_host_update', {
      question: room.currentWhoQuestion
    });
  } catch (e) {
    console.error(e);
  }
}

function sendImpostorTurnState(roomCode) {
  const room = rooms[roomCode];
  if (!room || room.players.length === 0) return;

  const activePlayer = room.players[room.currentTurnIndex];
  const nextPlayer = room.players[(room.currentTurnIndex + 1) % room.players.length];

  io.to(roomCode).emit('impostor_turn_update', {
    activePlayerId: activePlayer.id,
    activePlayerName: activePlayer.name,
    nextPlayerName: nextPlayer.name,
    roundCount: room.roundCount
  });
}

function sendTodTurnState(roomCode) {
  const room = rooms[roomCode];
  if (!room || !room.todPlayerOrder || room.todPlayerOrder.length === 0) return;

  const activePlayer = room.todPlayerOrder[room.currentTurnIndex];
  io.to(roomCode).emit('tod_player_turn', { playerId: activePlayer.id, playerName: activePlayer.name });
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server běží na portu ${PORT}`));
