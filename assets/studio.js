const DB_NAME = 'poisonink-local-v1';
const STORE_NAME = 'artworks';
const settingsKey = 'poisonink-settings';

const views = {
  dashboard: ['Seu estúdio', 'Um resumo real do que foi processado neste navegador.'],
  protect: ['Proteger imagem', 'Escolha, ajuste e exporte sem enviar sua arte para um servidor.'],
  archive: ['Arquivo local', 'As cópias salvas ficam apenas neste navegador.'],
  history: ['Histórico', 'Cada processamento registrado com data, intensidade e dimensões.'],
  settings: ['Preferências', 'Controle sua assinatura e o que deve permanecer armazenado.']
};

const strengthPresets = {
  light: { amount: 2, density: 28, visual: 'mínima', visualBar: 20 },
  balanced: { amount: 4, density: 52, visual: 'baixa', visualBar: 38 },
  strong: { amount: 7, density: 78, visual: 'moderada', visualBar: 62 }
};

let activeStrength = 'balanced';
let selectedFile = null;
let selectedImage = null;
let currentResult = null;
let resultUrl = '';
let dbPromise;
let toastTimer;
let archiveUrls = [];

const $ = (selector, scope = document) => scope.querySelector(selector);
const $$ = (selector, scope = document) => [...scope.querySelectorAll(selector)];

function openDatabase() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(STORE_NAME)) database.createObjectStore(STORE_NAME, { keyPath: 'id' });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  return dbPromise;
}

async function getRecords() {
  const database = await openDatabase();
  return new Promise((resolve, reject) => {
    const request = database.transaction(STORE_NAME, 'readonly').objectStore(STORE_NAME).getAll();
    request.onsuccess = () => resolve(request.result.sort((a, b) => b.createdAt - a.createdAt));
    request.onerror = () => reject(request.error);
  });
}

async function putRecord(record) {
  const database = await openDatabase();
  return new Promise((resolve, reject) => {
    const request = database.transaction(STORE_NAME, 'readwrite').objectStore(STORE_NAME).put(record);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
}

async function deleteRecord(id) {
  const database = await openDatabase();
  return new Promise((resolve, reject) => {
    const request = database.transaction(STORE_NAME, 'readwrite').objectStore(STORE_NAME).delete(id);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
}

async function clearRecords() {
  const database = await openDatabase();
  return new Promise((resolve, reject) => {
    const request = database.transaction(STORE_NAME, 'readwrite').objectStore(STORE_NAME).clear();
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
}

function loadSettings() {
  const fallback = { artistName: '', signature: '', saveThumbs: true, confirmClear: true };
  try { return { ...fallback, ...JSON.parse(localStorage.getItem(settingsKey) || '{}') }; }
  catch { return fallback; }
}

function saveSettings(values) {
  localStorage.setItem(settingsKey, JSON.stringify(values));
}

function showToast(message) {
  const toast = $('#toast');
  toast.textContent = message;
  toast.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove('show'), 3200);
}

function readableDate(timestamp) {
  return new Intl.DateTimeFormat('pt-BR', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }).format(new Date(timestamp));
}

function readableSize(bytes) {
  if (!bytes) return '0 MB';
  return `${(bytes / 1024 / 1024).toFixed(bytes > 1048576 ? 1 : 2)} MB`;
}

function safeName(name) {
  return name.replace(/\.[^/.]+$/, '').replace(/[^a-z0-9_-]+/gi, '-').replace(/^-|-$/g, '') || 'artwork';
}

function switchView(name) {
  if (!views[name]) return;
  $$('.studio-panel').forEach((panel) => { panel.hidden = panel.dataset.panel !== name; });
  $$('.studio-nav [data-view]').forEach((button) => button.setAttribute('aria-selected', String(button.dataset.view === name)));
  $('#viewTitle').textContent = views[name][0];
  $('#viewSubtitle').textContent = views[name][1];
  history.replaceState(null, '', `#${name}`);
  if (name === 'dashboard') renderDashboard();
  if (name === 'archive') renderArchive();
  if (name === 'history') renderHistory();
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

$$('[data-view]').forEach((button) => button.addEventListener('click', () => switchView(button.dataset.view)));
document.addEventListener('click', (event) => {
  const trigger = event.target.closest('[data-go]');
  if (trigger) switchView(trigger.dataset.go);
});

function updateStrength(name) {
  activeStrength = name;
  const preset = strengthPresets[name];
  $$('[data-strength]').forEach((button) => button.setAttribute('aria-pressed', String(button.dataset.strength === name)));
  $('#visualOutput').textContent = preset.visual;
  $('#densityOutput').textContent = `${preset.density}%`;
  $('#visualBar').style.width = `${preset.visualBar}%`;
  $('#densityBar').style.width = `${preset.density}%`;
}

$$('[data-strength]').forEach((button) => button.addEventListener('click', () => updateStrength(button.dataset.strength)));

const dropZone = $('#dropZone');
const fileInput = $('#fileInput');

['dragenter', 'dragover'].forEach((eventName) => dropZone.addEventListener(eventName, (event) => {
  event.preventDefault();
  dropZone.classList.add('dragging');
}));
['dragleave', 'drop'].forEach((eventName) => dropZone.addEventListener(eventName, (event) => {
  event.preventDefault();
  dropZone.classList.remove('dragging');
}));
dropZone.addEventListener('drop', (event) => loadFile(event.dataTransfer.files[0]));
fileInput.addEventListener('change', () => loadFile(fileInput.files[0]));

async function loadFile(file) {
  if (!file) return;
  if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type)) return showToast('Use uma imagem PNG, JPG ou WEBP.');
  if (file.size > 20 * 1024 * 1024) return showToast('Essa imagem passa do limite de 20 MB.');
  try {
    selectedFile = file;
    selectedImage = await createImageBitmap(file);
    const url = URL.createObjectURL(file);
    $('#sourcePreview').src = url;
    $('#sourcePreview').onload = () => URL.revokeObjectURL(url);
    dropZone.classList.add('has-image');
    $('#processButton').disabled = false;
    $('#resultCard').hidden = true;
    showToast('Imagem carregada apenas neste navegador.');
  } catch {
    showToast('Não foi possível ler essa imagem.');
  }
}

function seededRandom(seed) {
  let value = seed || 123456789;
  return () => {
    value ^= value << 13;
    value ^= value >>> 17;
    value ^= value << 5;
    return ((value >>> 0) % 100000) / 100000;
  };
}

function stringSeed(text) {
  let hash = 2166136261;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function canvasToBlob(canvas, quality = 0.96) {
  return new Promise((resolve, reject) => canvas.toBlob((blob) => blob ? resolve(blob) : reject(new Error('Export failed')), 'image/png', quality));
}

async function makeThumbnail(canvas) {
  const scale = Math.min(1, 520 / Math.max(canvas.width, canvas.height));
  const thumb = document.createElement('canvas');
  thumb.width = Math.max(1, Math.round(canvas.width * scale));
  thumb.height = Math.max(1, Math.round(canvas.height * scale));
  thumb.getContext('2d').drawImage(canvas, 0, 0, thumb.width, thumb.height);
  return canvasToBlob(thumb, .86);
}

async function sha256(blob) {
  const bytes = await blob.arrayBuffer();
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function processImage() {
  if (!selectedImage || !selectedFile) return;
  const processButton = $('#processButton');
  processButton.disabled = true;
  processButton.textContent = 'Processando localmente…';
  try {
    const maxSide = 2400;
    const scale = Math.min(1, maxSide / Math.max(selectedImage.width, selectedImage.height));
    const width = Math.max(1, Math.round(selectedImage.width * scale));
    const height = Math.max(1, Math.round(selectedImage.height * scale));
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext('2d', { willReadFrequently: true });
    context.drawImage(selectedImage, 0, 0, width, height);

    const preset = strengthPresets[activeStrength];
    const imageData = context.getImageData(0, 0, width, height);
    const pixels = imageData.data;
    const settings = loadSettings();
    const random = seededRandom(stringSeed(`${selectedFile.name}:${selectedFile.size}:${settings.signature}:${activeStrength}`));
    const threshold = preset.density / 100;
    for (let index = 0; index < pixels.length; index += 4) {
      if (random() > threshold) continue;
      const direction = random() > .5 ? 1 : -1;
      const amount = Math.max(1, Math.round(random() * preset.amount)) * direction;
      pixels[index] = Math.max(0, Math.min(255, pixels[index] + amount));
      pixels[index + 1] = Math.max(0, Math.min(255, pixels[index + 1] - amount));
      pixels[index + 2] = Math.max(0, Math.min(255, pixels[index + 2] + Math.round(amount / 2)));
    }
    context.putImageData(imageData, 0, 0);

    const signature = settings.signature || settings.artistName || 'POISONINK';
    context.save();
    context.globalAlpha = activeStrength === 'strong' ? .045 : activeStrength === 'light' ? .018 : .03;
    context.fillStyle = '#ffffff';
    context.font = `${Math.max(10, Math.round(width / 110))}px DM Mono, monospace`;
    context.textBaseline = 'bottom';
    const mark = `${signature} · POISONINK LOCAL`;
    const spacing = Math.max(90, width / 5);
    for (let y = spacing; y < height + spacing; y += spacing) {
      for (let x = -spacing; x < width + spacing; x += spacing * 1.4) {
        context.save();
        context.translate(x, y);
        context.rotate(-Math.PI / 8);
        context.fillText(mark, 0, 0);
        context.restore();
      }
    }
    context.restore();

    const blob = await canvasToBlob(canvas);
    const hash = await sha256(blob);
    const thumb = await makeThumbnail(canvas);
    const createdAt = Date.now();
    const outputName = `${safeName(selectedFile.name)}-poisonink.png`;
    const record = {
      id: crypto.randomUUID(),
      name: outputName,
      originalName: selectedFile.name,
      createdAt,
      strength: activeStrength,
      width,
      height,
      size: blob.size,
      hash,
      blob: loadSettings().saveThumbs ? blob : null,
      thumbnail: loadSettings().saveThumbs ? thumb : null
    };
    await putRecord(record);
    currentResult = record;
    if (resultUrl) URL.revokeObjectURL(resultUrl);
    resultUrl = URL.createObjectURL(blob);
    $('#resultPreview').src = resultUrl;
    $('#resultName').textContent = `${outputName} · ${readableSize(blob.size)}`;
    $('#resultDimensions').textContent = `${width} × ${height} px`;
    $('#resultHash').textContent = hash;
    $('#downloadButton').href = resultUrl;
    $('#downloadButton').download = outputName;
    $('#resultCard').hidden = false;
    $('#resultCard').scrollIntoView({ behavior: 'smooth', block: 'start' });
    showToast('Cópia gerada e registrada no histórico local.');
  } catch (error) {
    console.error(error);
    showToast('O processamento falhou. Tente uma imagem menor.');
  } finally {
    processButton.disabled = false;
    processButton.textContent = 'Gerar cópia protegida';
  }
}

$('#processButton').addEventListener('click', processImage);
$('#copyHashButton').addEventListener('click', async () => {
  if (!currentResult) return;
  await navigator.clipboard.writeText(currentResult.hash);
  showToast('Impressão copiada.');
});
$('#newImageButton').addEventListener('click', () => {
  selectedFile = null;
  selectedImage?.close?.();
  selectedImage = null;
  fileInput.value = '';
  dropZone.classList.remove('has-image');
  $('#sourcePreview').removeAttribute('src');
  $('#processButton').disabled = true;
  $('#resultCard').hidden = true;
  dropZone.scrollIntoView({ behavior: 'smooth', block: 'center' });
});

async function renderDashboard() {
  const records = await getRecords();
  const weekAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
  const totalSize = records.reduce((sum, record) => sum + (record.size || 0), 0);
  $('#statTotal').textContent = records.length;
  $('#statWeek').textContent = records.filter((record) => record.createdAt >= weekAgo).length;
  $('#statSize').innerHTML = `${(totalSize / 1024 / 1024).toFixed(1)} <span>MB</span>`;
  const target = $('#recentActivity');
  if (!records.length) {
    target.className = 'activity-empty';
    target.textContent = 'Seu histórico começa quando você exportar a primeira imagem.';
    return;
  }
  target.className = 'activity-list';
  target.replaceChildren(...records.slice(0, 4).map((record) => {
    const row = document.createElement('div');
    row.className = 'activity-row';
    const image = document.createElement('img');
    image.className = 'activity-thumb';
    image.alt = '';
    if (record.thumbnail) image.src = URL.createObjectURL(record.thumbnail);
    const copy = document.createElement('div');
    copy.innerHTML = `<strong></strong><small></small>`;
    $('strong', copy).textContent = record.originalName;
    $('small', copy).textContent = readableDate(record.createdAt);
    const score = document.createElement('span');
    score.className = 'activity-score';
    score.textContent = record.strength.toUpperCase();
    row.append(image, copy, score);
    return row;
  }));
}

async function renderArchive() {
  archiveUrls.forEach(URL.revokeObjectURL);
  archiveUrls = [];
  const records = await getRecords();
  const target = $('#archiveContent');
  if (!records.length) {
    target.className = 'empty-state';
    target.innerHTML = 'Nenhuma imagem armazenada neste navegador.<br><br><button class="button primary small" type="button" data-go="protect">Preparar primeira imagem</button>';
    return;
  }
  target.className = 'archive-grid';
  target.replaceChildren(...records.map((record) => {
    const card = document.createElement('article');
    card.className = 'art-card';
    const image = document.createElement('img');
    image.alt = `Miniatura de ${record.originalName}`;
    if (record.thumbnail) {
      const url = URL.createObjectURL(record.thumbnail);
      archiveUrls.push(url);
      image.src = url;
    }
    const meta = document.createElement('div');
    meta.className = 'art-meta';
    const title = document.createElement('strong');
    title.textContent = record.originalName;
    const detail = document.createElement('small');
    detail.textContent = `${readableDate(record.createdAt)} · ${record.width}×${record.height}`;
    const buttons = document.createElement('div');
    buttons.className = 'art-buttons';
    if (record.blob) {
      const download = document.createElement('a');
      const url = URL.createObjectURL(record.blob);
      archiveUrls.push(url);
      download.href = url;
      download.download = record.name;
      download.textContent = 'BAIXAR';
      buttons.append(download);
    } else {
      const unavailable = document.createElement('button');
      unavailable.disabled = true;
      unavailable.textContent = 'NÃO SALVO';
      buttons.append(unavailable);
    }
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.textContent = '×';
    remove.setAttribute('aria-label', `Remover ${record.originalName}`);
    remove.addEventListener('click', async () => {
      if (!confirm(`Remover ${record.originalName} do arquivo local?`)) return;
      await deleteRecord(record.id);
      await renderArchive();
      showToast('Registro removido do navegador.');
    });
    buttons.append(remove);
    meta.append(title, detail, buttons);
    card.append(image, meta);
    return card;
  }));
}

async function renderHistory() {
  const records = await getRecords();
  const body = $('#historyRows');
  if (!records.length) {
    body.innerHTML = '<tr><td colspan="5">Nenhum processamento registrado.</td></tr>';
    return;
  }
  body.replaceChildren(...records.map((record) => {
    const row = document.createElement('tr');
    [record.originalName, readableDate(record.createdAt), record.strength, `${record.width} × ${record.height}`, 'CONCLUÍDO'].forEach((value, index) => {
      const cell = document.createElement('td');
      cell.textContent = value;
      if (index === 4) cell.className = 'success-label';
      row.append(cell);
    });
    return row;
  }));
}

function renderSettings() {
  const settings = loadSettings();
  $('#artistName').value = settings.artistName;
  $('#signature').value = settings.signature;
  $('#saveThumbsToggle').setAttribute('aria-pressed', String(settings.saveThumbs));
  $('#confirmClearToggle').setAttribute('aria-pressed', String(settings.confirmClear));
}

$$('.toggle').forEach((button) => button.addEventListener('click', () => {
  button.setAttribute('aria-pressed', String(button.getAttribute('aria-pressed') !== 'true'));
}));

$('#saveSettings').addEventListener('click', () => {
  saveSettings({
    artistName: $('#artistName').value.trim(),
    signature: $('#signature').value.trim(),
    saveThumbs: $('#saveThumbsToggle').getAttribute('aria-pressed') === 'true',
    confirmClear: $('#confirmClearToggle').getAttribute('aria-pressed') === 'true'
  });
  showToast('Preferências salvas neste navegador.');
});

$('#clearDataButton').addEventListener('click', async () => {
  const settings = loadSettings();
  if (settings.confirmClear && !confirm('Limpar todo o histórico e as imagens salvas neste navegador?')) return;
  await clearRecords();
  await renderDashboard();
  showToast('Dados locais removidos.');
});

window.addEventListener('hashchange', () => switchView(location.hash.slice(1) || 'dashboard'));
window.addEventListener('beforeunload', () => {
  if (resultUrl) URL.revokeObjectURL(resultUrl);
  archiveUrls.forEach(URL.revokeObjectURL);
});

renderSettings();
updateStrength('balanced');
switchView(views[location.hash.slice(1)] ? location.hash.slice(1) : 'dashboard');
