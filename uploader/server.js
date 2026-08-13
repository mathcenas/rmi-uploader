const express  = require('express');
const multer   = require('multer');
const path     = require('path');
const fs       = require('fs');
const AdmZip   = require('adm-zip');
const https    = require('https');
const { spawn, execFile } = require('child_process');

const app             = express();
const PORT            = process.env.PORT            || 8080;
const UPLOAD_DIR      = process.env.UPLOAD_DIR      || '/tmp/rmi';
const BACKUPS_DIR     = process.env.BACKUPS_DIR     || '/backups';
const UPLOAD_PASSWORD = process.env.UPLOAD_PASSWORD || 'rmi2024';
const ADMIN_PASSWORD  = process.env.ADMIN_PASSWORD  || 'admin2024';
const RESEND_API_KEY  = process.env.RESEND_API_KEY  || '';
const RESEND_FROM     = process.env.RESEND_FROM     || 'RMI Uploader <noreply@cenas.com.uy>';

const APPS = {
  gestion_prod:      { label: 'Gestion RMI',      env: 'Produccion', dir: '/srv/gestion-rmi/prod',                  container: 'gestion-rmi' },
  gestion_test:      { label: 'Gestion RMI',      env: 'Testing',    dir: '/srv/gestion-rmi/testing',               container: 'gestion-rmi-testing' },
  contabilidad_prod: { label: 'Contabilidad RMI', env: 'Produccion', dir: '/srv/contabilidad-rmi/rmi-contabilidad', container: 'contabilidad-rmi' },
};

const ALLOWED_FILES = new Set(['server.js', 'package.json', 'index.html']);
const ALLOWED_DIRS  = new Set(['public', 'views']);

fs.mkdirSync(UPLOAD_DIR, { recursive: true });
fs.mkdirSync(BACKUPS_DIR, { recursive: true });

// ── Helpers ───────────────────────────────────────────────────────────────────

function fmtSize(bytes) {
  if (bytes < 1024)         return `${bytes} B`;
  if (bytes < 1024 * 1024)  return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

function fmtDate(d) {
  return new Date(d).toLocaleString('es-UY', { timeZone: 'America/Montevideo' });
}

function tsDir() {
  return new Date().toISOString().replace(/[:.]/g, '-').replace('T', '_').slice(0, 19);
}

function sendResend(to, subject, html) {
  if (!RESEND_API_KEY) { console.log('[resend] sin API key, email omitido'); return; }
  console.log(`[resend] enviando a ${to} — "${subject}"`);
  const body = JSON.stringify({ from: RESEND_FROM, to: [to], subject, html });
  const req  = https.request(
    { hostname: 'api.resend.com', path: '/emails', method: 'POST',
      headers: { 'Authorization': `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } },
    (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          console.log(`[resend] OK ${res.statusCode} — ${data}`);
        } else {
          console.error(`[resend] ERROR ${res.statusCode} — ${data}`);
        }
      });
    }
  );
  req.on('error', (e) => console.error(`[resend] error de red: ${e.message}`));
  req.write(body);
  req.end();
}

// ── Auth middlewares ──────────────────────────────────────────────────────────

function uploadAuth(req, res, next) {
  if (req.headers['x-upload-password'] !== UPLOAD_PASSWORD) {
    return res.status(401).json({ error: 'Contraseña incorrecta' });
  }
  next();
}

function adminAuth(req, res, next) {
  if (req.headers['x-admin-password'] !== ADMIN_PASSWORD) {
    return res.status(401).json({ error: 'Acceso denegado' });
  }
  next();
}

// ── Multer — temp storage ─────────────────────────────────────────────────────

const tmpStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    const dir = path.join(UPLOAD_DIR, '_tmp_' + Date.now());
    fs.mkdirSync(dir, { recursive: true });
    req._tmpDir = dir;
    cb(null, dir);
  },
  filename: (req, file, cb) => cb(null, file.originalname)
});

const upload = multer({
  storage: tmpStorage,
  limits: { fileSize: 100 * 1024 * 1024, files: 4 },
  fileFilter: (req, file, cb) => {
    const ext  = path.extname(file.originalname).toLowerCase();
    const base = path.basename(file.originalname);
    if (ext === '.zip' || ALLOWED_FILES.has(base)) return cb(null, true);
    cb(new Error(`Archivo no permitido: ${file.originalname}`));
  }
});

// ── Static ────────────────────────────────────────────────────────────────────

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

// ── Upload endpoint ───────────────────────────────────────────────────────────

app.post('/upload', uploadAuth, (req, res) => {
  upload.array('files')(req, res, async (err) => {
    if (err) { console.error(`[upload] multer error: ${err.message}`); return res.status(400).json({ error: err.message }); }

    const app_id = req.body && req.body.app;
    const email  = req.body && req.body.email ? req.body.email.trim() : '';
    const appCfg = APPS[app_id];
    console.log(`[upload] app=${app_id} email=${email || '(ninguno)'} files=${req.files ? req.files.length : 0}`);

    if (!appCfg) {
      cleanTmp(req._tmpDir);
      return res.status(400).json({ error: 'Aplicacion no valida' });
    }

    if (!req.files || req.files.length === 0) {
      cleanTmp(req._tmpDir);
      return res.status(400).json({ error: 'No se recibieron archivos' });
    }

    const ts      = tsDir();
    const destDir = path.resolve(UPLOAD_DIR, `${app_id}_${ts}`);
    fs.mkdirSync(destDir, { recursive: true });

    try {
      const files      = req.files;
      const firstFile  = files[0];
      const isZip      = firstFile.originalname.toLowerCase().endsWith('.zip');
      let   uploadedFiles = [];

      if (isZip) {
        // ── Unzip ──────────────────────────────────────────────────────────
        const zip     = new AdmZip(firstFile.path);
        const entries = zip.getEntries();
        let   extracted = 0;

        for (const entry of entries) {
          if (entry.isDirectory) continue;
          const entryPath = entry.entryName.replace(/\\/g, '/');
          const parts     = entryPath.split('/');
          // strip top-level folder if all entries share one
          const topDir    = entries.every(e => e.entryName.startsWith(parts[0] + '/')) ? parts.slice(1) : parts;
          const relative  = topDir.join('/');
          const topSegment = relative.split('/')[0];

          if (!ALLOWED_FILES.has(topSegment) && !ALLOWED_DIRS.has(topSegment)) continue;

          // Evitar zip-slip: el destino resuelto debe quedar dentro de destDir
          const outPath = path.resolve(destDir, relative);
          if (outPath !== destDir && !outPath.startsWith(destDir + path.sep)) {
            console.warn(`[upload] entrada de ZIP fuera de destino, ignorada: ${entry.entryName}`);
            continue;
          }

          fs.mkdirSync(path.dirname(outPath), { recursive: true });
          fs.writeFileSync(outPath, entry.getData());
          uploadedFiles.push(relative);
          extracted++;
        }

        if (extracted === 0) {
          cleanTmp(req._tmpDir);
          cleanTmp(destDir);
          return res.status(400).json({ error: 'El ZIP no contiene archivos reconocidos (server.js, package.json, public/, views/)' });
        }
      } else {
        // ── Archivos individuales ──────────────────────────────────────────
        for (const f of files) {
          const dest = path.join(destDir, f.originalname);
          fs.mkdirSync(path.dirname(dest), { recursive: true });
          fs.copyFileSync(f.path, dest);
          uploadedFiles.push(f.originalname);
        }
      }

      cleanTmp(req._tmpDir);

      // ── Guardar meta (email del uploader) ─────────────────────────────────
      const meta = { email, app: app_id, label: appCfg.label, env: appCfg.env, date: new Date().toISOString() };
      try { fs.writeFileSync(path.join(destDir, '_meta.json'), JSON.stringify(meta)); } catch {}

      // ── Notificacion email ─────────────────────────────────────────────────
      if (email) {
        const fileList = uploadedFiles.map(f => `<li style="margin:2px 0;">${f}</li>`).join('');
        const envBadgeColor = appCfg.env === 'Testing' ? '#0369a1' : '#15803d';
        const envBadgeBg    = appCfg.env === 'Testing' ? '#e0f2fe' : '#dcfce7';
        sendResend(
          email,
          `[RMI] Archivos recibidos — deploy pendiente — ${appCfg.label} (${appCfg.env})`,
          `<div style="font-family:sans-serif;max-width:480px;color:#1e293b">
            <h2 style="color:#2563eb;margin-bottom:8px">RMI Uploader</h2>
            <p style="margin-bottom:4px">Los archivos fueron recibidos correctamente.</p>
            <p style="margin-bottom:16px;padding:10px 14px;background:#fef9c3;border-left:4px solid #ca8a04;font-size:13px;color:#854d0e;">
              <strong>Deploy pendiente.</strong> Un administrador debe ejecutar <code>./update-rmi.sh ${app_id}</code> en el servidor para aplicar los cambios.
            </p>
            <table style="width:100%;border-collapse:collapse;font-size:13px">
              <tr><td style="padding:6px 0;color:#64748b;width:120px">Aplicacion</td><td><strong>${appCfg.label}</strong></td></tr>
              <tr><td style="padding:6px 0;color:#64748b">Ambiente</td><td><span style="display:inline-block;padding:2px 8px;border-radius:4px;font-size:11px;font-weight:700;background:${envBadgeBg};color:${envBadgeColor}">${appCfg.env}</span></td></tr>
              <tr><td style="padding:6px 0;color:#64748b">Guardado en</td><td><code style="font-size:12px">${destDir}</code></td></tr>
              <tr><td style="padding:6px 0;color:#64748b">Fecha</td><td>${fmtDate(new Date())}</td></tr>
              <tr><td style="padding:6px 0;color:#64748b">Archivos</td><td><ul style="margin:0;padding-left:16px">${fileList}</ul></td></tr>
            </table>
            <p style="margin-top:20px;font-size:12px;color:#94a3b8">Este mensaje fue generado automaticamente por RMI Uploader.</p>
          </div>`
        );
      }

      res.json({
        ok:       true,
        app:      appCfg.label,
        ambiente: appCfg.env,
        destino:  destDir,
        archivos: uploadedFiles,
        fecha:    fmtDate(new Date())
      });

    } catch (e) {
      cleanTmp(req._tmpDir);
      cleanTmp(destDir);
      res.status(500).json({ error: e.message });
    }
  });
});

// ── Status ────────────────────────────────────────────────────────────────────

app.get('/status', (req, res) => {
  try {
    const entries = fs.readdirSync(UPLOAD_DIR)
      .filter(f => !f.startsWith('_tmp_'))
      .map(name => {
        const stats = fs.statSync(path.join(UPLOAD_DIR, name));
        return { name, mtime: stats.mtime.getTime(), modified: fmtDate(stats.mtime) };
      })
      .sort((a, b) => b.mtime - a.mtime);

    const latest = entries[0] || null;
    res.json({ total: entries.length, ultimo: latest ? { nombre: latest.name, modificado: latest.modified } : null });
  } catch {
    res.json({ total: 0, ultimo: null });
  }
});

app.get('/health', (req, res) => {
  res.json({ status: 'ok', service: 'rmi-uploader', uptime: Math.floor(process.uptime()), timestamp: fmtDate(new Date()) });
});

// ── Admin upload (sin filtro) ─────────────────────────────────────────────────

const adminUploadStorage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename: (req, file, cb) => {
    const base = path.basename(file.originalname);
    const ext  = path.extname(base);
    const name = path.basename(base, ext);
    const dest = path.join(UPLOAD_DIR, base);
    if (!fs.existsSync(dest)) return cb(null, base);
    cb(null, `${name}_${Date.now()}${ext}`);
  }
});
const adminUpload = multer({ storage: adminUploadStorage, limits: { fileSize: 200 * 1024 * 1024, files: 20 } });

app.post('/mgmt/upload', adminAuth, (req, res) => {
  adminUpload.array('files')(req, res, (err) => {
    if (err) return res.status(400).json({ error: err.message });
    if (!req.files || req.files.length === 0) return res.status(400).json({ error: 'No se recibieron archivos' });
    res.json({ ok: true, archivos: req.files.map(f => f.filename) });
  });
});

// ── Admin ─────────────────────────────────────────────────────────────────────

app.get('/mgmt/files', adminAuth, (req, res) => {
  try {
    const entries = fs.readdirSync(UPLOAD_DIR)
      .filter(f => !f.startsWith('_tmp_'))
      .map(name => {
        const fullPath = path.join(UPLOAD_DIR, name);
        const stats    = fs.statSync(fullPath);
        const isDir    = stats.isDirectory();
        const sizeBytes = isDir ? dirSize(fullPath) : stats.size;
        return { name, isDir, size: fmtSize(sizeBytes), sizeBytes, modified: fmtDate(stats.mtime), mtime: stats.mtime.getTime() };
      })
      .sort((a, b) => b.mtime - a.mtime);
    res.json({ files: entries });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/mgmt/download/:name', adminAuth, (req, res) => {
  const name = req.params.name;
  if (!name || name.includes('/') || name.includes('..')) {
    return res.status(400).json({ error: 'Nombre invalido' });
  }
  const target = path.join(UPLOAD_DIR, name);
  if (!fs.existsSync(target)) return res.status(404).json({ error: 'No encontrado' });

  const stats = fs.statSync(target);
  if (stats.isDirectory()) {
    try {
      const zip = new AdmZip();
      zip.addLocalFolder(target, name);
      const buffer = zip.toBuffer();
      res.setHeader('Content-Type', 'application/zip');
      res.setHeader('Content-Disposition', `attachment; filename="${name}.zip"`);
      res.send(buffer);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  } else {
    res.download(target, name);
  }
});

app.post('/mgmt/delete', adminAuth, (req, res) => {
  const { name } = req.body || {};
  if (!name || typeof name !== 'string' || name.includes('/') || name.includes('..')) {
    return res.status(400).json({ error: 'Nombre invalido' });
  }
  const target = path.join(UPLOAD_DIR, name);
  if (!fs.existsSync(target)) return res.status(404).json({ error: 'No encontrado' });
  try {
    fs.rmSync(target, { recursive: true, force: true });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Ejecuta update-rmi.sh contra srcPath (un upload o un backup) y streamea el
// log por SSE. Usado tanto por /mgmt/deploy como por /mgmt/restore.
function runDeploy(res, app_id, srcPath, notify, uploaderEmail, label) {
  const scriptPath = path.join(__dirname, '..', 'update-rmi.sh');

  console.log(`[${label}] app=${app_id} src=${srcPath} admin=${notify || '(ninguno)'} uploader=${uploaderEmail || '(ninguno)'}`);

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  const emit = (data, event = 'log') => {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  const env  = { ...process.env, DEPLOY_SRC: srcPath, DEPLOY_NOTIFY_EMAIL: '' };
  const proc = spawn('bash', [scriptPath, app_id], { env });

  proc.stdout.on('data', d => { console.log(`[${label}]`, d.toString().trimEnd()); emit(d.toString()); });
  proc.stderr.on('data', d => { console.error(`[${label}:err]`, d.toString().trimEnd()); emit(d.toString()); });

  proc.on('close', code => {
    console.log(`[${label}] exit=${code}`);

    const appCfg     = APPS[app_id];
    const deployDate = fmtDate(new Date());
    const accion      = label === 'restore' ? 'Restauracion aplicada' : 'Deploy aplicado';
    const subject     = `[RMI] ${accion} — ${appCfg.label} (${appCfg.env})`;
    const html = `<div style="font-family:sans-serif;max-width:480px;color:#1e293b">
      <h2 style="color:#16a34a;margin-bottom:8px">RMI ${label === 'restore' ? 'Restore' : 'Deploy'} — ${code === 0 ? 'OK' : 'ERROR'}</h2>
      <table style="width:100%;border-collapse:collapse;font-size:13px">
        <tr><td style="padding:6px 0;color:#64748b;width:120px">Aplicacion</td><td><strong>${appCfg.label}</strong></td></tr>
        <tr><td style="padding:6px 0;color:#64748b">Ambiente</td><td><strong>${appCfg.env}</strong></td></tr>
        <tr><td style="padding:6px 0;color:#64748b">Directorio</td><td><code style="font-size:12px">${appCfg.dir}</code></td></tr>
        <tr><td style="padding:6px 0;color:#64748b">Fecha</td><td>${deployDate}</td></tr>
        <tr><td style="padding:6px 0;color:#64748b">Estado</td><td><strong>${code === 0 ? 'Exitoso' : 'Fallo (codigo ' + code + ')'}</strong></td></tr>
      </table>
      <p style="margin-top:20px;font-size:12px;color:#94a3b8">RMI ${label === 'restore' ? 'Restore' : 'Deploy'} automatico.</p>
    </div>`;

    if (code === 0) {
      if (uploaderEmail) sendResend(uploaderEmail, subject, html);
      if (notify && notify !== uploaderEmail) sendResend(notify, subject, html);
    }

    emit({ code, ok: code === 0 }, 'done');
    res.end();
  });

  proc.on('error', err => {
    emit(`No se pudo ejecutar update-rmi.sh: ${err.message}`);
    emit({ code: -1, ok: false }, 'done');
    res.end();
  });
}

app.post('/mgmt/deploy', adminAuth, (req, res) => {
  const { name, email } = req.body || {};
  if (!name || typeof name !== 'string' || name.includes('/') || name.includes('..')) {
    return res.status(400).json({ error: 'Nombre invalido' });
  }

  const knownApps = Object.keys(APPS);
  const app_id = knownApps.find(id => name.startsWith(id + '_'));
  if (!app_id) return res.status(400).json({ error: 'No se pudo inferir la app del nombre del directorio' });

  const uploadPath = path.join(UPLOAD_DIR, name);
  if (!fs.existsSync(uploadPath)) return res.status(404).json({ error: 'Directorio no encontrado' });

  const notify = email || process.env.DEPLOY_NOTIFY_EMAIL || '';

  // ── Leer email del uploader original ─────────────────────────────────────
  let uploaderEmail = '';
  try {
    const metaPath = path.join(uploadPath, '_meta.json');
    if (fs.existsSync(metaPath)) {
      uploaderEmail = (JSON.parse(fs.readFileSync(metaPath, 'utf-8')).email || '').trim();
    }
  } catch {}

  runDeploy(res, app_id, uploadPath, notify, uploaderEmail, 'deploy');
});

app.post('/mgmt/restore', adminAuth, (req, res) => {
  const { name, email } = req.body || {};
  if (!name || typeof name !== 'string' || name.includes('/') || name.includes('..')) {
    return res.status(400).json({ error: 'Nombre invalido' });
  }

  const knownApps = Object.keys(APPS);
  const app_id = knownApps.find(id => name.startsWith(id + '_'));
  if (!app_id) return res.status(400).json({ error: 'No se pudo inferir la app del nombre del backup' });

  const backupPath = path.join(BACKUPS_DIR, name);
  if (!fs.existsSync(backupPath)) return res.status(404).json({ error: 'Backup no encontrado' });

  const notify = email || process.env.DEPLOY_NOTIFY_EMAIL || '';

  runDeploy(res, app_id, backupPath, notify, '', 'restore');
});

app.get('/mgmt/backups', adminAuth, (req, res) => {
  try {
    const entries = fs.readdirSync(BACKUPS_DIR)
      .map(name => {
        const fullPath = path.join(BACKUPS_DIR, name);
        const stats    = fs.statSync(fullPath);
        const isDir    = stats.isDirectory();
        const sizeBytes = isDir ? dirSize(fullPath) : stats.size;
        return { name, isDir, size: fmtSize(sizeBytes), sizeBytes, modified: fmtDate(stats.mtime), mtime: stats.mtime.getTime() };
      })
      .sort((a, b) => b.mtime - a.mtime);
    res.json({ backups: entries });
  } catch (e) {
    res.json({ backups: [] });
  }
});

app.get('/mgmt/container-status', adminAuth, (req, res) => {
  execFile('docker', ['ps', '-a', '--format', '{{.Names}}|{{.State}}'], (err, stdout) => {
    const states = {};
    if (!err) {
      stdout.trim().split('\n').filter(Boolean).forEach(line => {
        const [name, state] = line.split('|');
        states[name] = state;
      });
    }
    const containers = {};
    for (const [app_id, cfg] of Object.entries(APPS)) {
      containers[app_id] = { name: cfg.container, state: states[cfg.container] || 'not-found' };
    }
    res.json({ containers });
  });
});

app.get('/mgmt/readme', adminAuth, (req, res) => {
  try {
    res.type('text/plain').send(fs.readFileSync(path.join(__dirname, 'README.md'), 'utf-8'));
  } catch (e) {
    res.status(404).type('text/plain').send('README.md no disponible en esta imagen.');
  }
});

// ── Utils ─────────────────────────────────────────────────────────────────────

function cleanTmp(dir) {
  if (!dir) return;
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
}

function dirSize(dir) {
  let total = 0;
  try {
    for (const f of fs.readdirSync(dir)) {
      const fp = path.join(dir, f);
      const s  = fs.statSync(fp);
      total += s.isDirectory() ? dirSize(fp) : s.size;
    }
  } catch {}
  return total;
}

// ── Start ─────────────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`Uploader RMI en puerto ${PORT}`);
  console.log(`Archivos en: ${UPLOAD_DIR}`);
  console.log(`Resend: ${RESEND_API_KEY ? 'configurado' : 'no configurado'}`);
});
