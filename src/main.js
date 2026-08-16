const { app, BrowserWindow, dialog, ipcMain, shell, Menu, screen } = require('electron');
const path = require('path');
const fs = require('fs');
const fsp = fs.promises;
const os = require('os');
const { spawn } = require('child_process');

const AUDIO_EXTENSIONS = new Set(['.mp3', '.wav', '.m4a', '.aac', '.ogg', '.flac', '.wma', '.opus']);
const VIDEO_EXTENSIONS = new Set(['.mp4', '.mov', '.mkv', '.avi', '.webm', '.m4v', '.wmv', '.mpeg', '.mpg']);
const IMAGE_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.webp', '.bmp', '.tif', '.tiff']);
const SUBTITLE_EXTENSIONS = new Set(['.srt']);
const naturalSort = new Intl.Collator('vi', { numeric: true, sensitivity: 'base' });

let mainWindow;
const activeProcesses = new Set();
let cancelRequested = false;
let processing = false;
let hardwareDetectionPromise = null;

const WINDOW_CONTENT_WIDTH = 1080;
const WINDOW_MIN_CONTENT_HEIGHT = 720;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: WINDOW_CONTENT_WIDTH,
    height: 780,
    useContentSize: true,
    resizable: false,
    maximizable: false,
    autoHideMenuBar: true,
    backgroundColor: '#0b1020',
    title: 'TDQ Video Sync',
    icon: path.join(__dirname, 'assets', 'tdq-video-sync-icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });

  mainWindow.setMenuBarVisibility(false);
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  mainWindow.webContents.on('will-navigate', (event) => event.preventDefault());
  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
}

app.setAppUserModelId('vn.tdq.videosync');

app.whenReady().then(() => {
  Menu.setApplicationMenu(null);
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

ipcMain.on('resize-window-to-content', (event, requestedHeight) => {
  if (!mainWindow || mainWindow.isDestroyed() || event.sender !== mainWindow.webContents) return;

  const contentHeight = Number(requestedHeight);
  if (!Number.isFinite(contentHeight)) return;

  const display = screen.getDisplayMatching(mainWindow.getBounds());
  const frameHeight = mainWindow.getBounds().height - mainWindow.getContentBounds().height;
  const maxContentHeight = Math.max(WINDOW_MIN_CONTENT_HEIGHT, display.workArea.height - frameHeight);
  const targetHeight = Math.min(Math.max(Math.ceil(contentHeight), WINDOW_MIN_CONTENT_HEIGHT), maxContentHeight);
  const currentContent = mainWindow.getContentBounds();
  if (Math.abs(currentContent.height - targetHeight) < 2) return;

  mainWindow.setContentSize(WINDOW_CONTENT_WIDTH, targetHeight, true);
  mainWindow.center();
});

app.on('window-all-closed', () => {
  for (const child of activeProcesses) child.kill();
  if (process.platform !== 'darwin') app.quit();
});

function ffmpegPath() {
  if (app.isPackaged) return path.join(process.resourcesPath, 'bin', 'ffmpeg.exe');
  return require('ffmpeg-static');
}

function ffprobePath() {
  if (app.isPackaged) return path.join(process.resourcesPath, 'bin', 'ffprobe.exe');
  return require('ffprobe-static').path;
}

function testEncoder(encoder) {
  return new Promise((resolve) => {
    const args = [
      '-hide_banner', '-loglevel', 'error',
      '-f', 'lavfi', '-i', 'color=c=black:s=640x360:r=30',
      '-vf', 'format=nv12', '-frames:v', '3',
      '-c:v', encoder, '-f', 'null', '-'
    ];
    const child = spawn(ffmpegPath(), args, { windowsHide: true });
    let settled = false;
    const finish = (available) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve(available);
    };
    const timeout = setTimeout(() => {
      child.kill();
      finish(false);
    }, 8000);
    child.on('error', () => finish(false));
    child.on('close', (code) => finish(code === 0));
  });
}

async function detectHardwareEncoder() {
  const candidates = [
    { encoder: 'h264_nvenc', label: 'NVIDIA NVENC', vendor: 'nvidia' },
    { encoder: 'h264_qsv', label: 'Intel Quick Sync', vendor: 'intel' },
    { encoder: 'h264_amf', label: 'AMD AMF', vendor: 'amd' }
  ];
  for (const candidate of candidates) {
    if (await testEncoder(candidate.encoder)) return { available: true, ...candidate };
  }
  return { available: false, encoder: 'libx264', label: 'Không tìm thấy GPU encode tương thích', vendor: 'cpu' };
}

function getHardwareInfo(refresh = false) {
  if (refresh || !hardwareDetectionPromise) hardwareDetectionPromise = detectHardwareEncoder();
  return hardwareDetectionPromise;
}

async function resolveEncoder(mode) {
  if (mode === 'cpu') return { encoder: 'libx264', label: 'CPU (libx264)', vendor: 'cpu', hardware: false };
  const detected = await getHardwareInfo();
  if (detected.available) return { ...detected, hardware: true };
  if (mode === 'gpu') throw new Error('Không tìm thấy GPU hỗ trợ NVENC, Intel Quick Sync hoặc AMD AMF. Hãy chọn Auto hoặc CPU.');
  return { encoder: 'libx264', label: 'CPU tự động (libx264)', vendor: 'cpu', hardware: false };
}

function videoEncoderArgs(encoderInfo, crf) {
  const quality = String(crf);
  if (encoderInfo.encoder === 'h264_nvenc') return ['-c:v', 'h264_nvenc', '-preset', 'p4', '-tune', 'hq', '-rc', 'vbr', '-cq', quality, '-b:v', '0'];
  if (encoderInfo.encoder === 'h264_qsv') return ['-c:v', 'h264_qsv', '-preset', 'medium', '-global_quality', quality];
  if (encoderInfo.encoder === 'h264_amf') return ['-c:v', 'h264_amf', '-quality', 'balanced', '-rc', 'cqp', '-qp_i', quality, '-qp_p', quality, '-qp_b', quality];
  return ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', quality];
}

function extractOrder(fileName) {
  const groups = path.basename(fileName, path.extname(fileName)).match(/\d+/g);
  if (!groups?.length) return null;
  return groups.at(-1).replace(/^0+(?=\d)/, '');
}

async function listFiles(folder, extensions) {
  const entries = await fsp.readdir(folder, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && extensions.has(path.extname(entry.name).toLowerCase()))
    .map((entry) => ({ name: entry.name, path: path.join(folder, entry.name), order: extractOrder(entry.name) }))
    .sort((a, b) => naturalSort.compare(a.name, b.name));
}

function mediaType(fileName) {
  return IMAGE_EXTENSIONS.has(path.extname(fileName).toLowerCase()) ? 'image' : 'video';
}

function parseSrtTimestamp(value) {
  const match = String(value).trim().match(/^(\d+):(\d{2}):(\d{2})[,.](\d{3})$/);
  if (!match) return null;
  return Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]) + Number(match[4]) / 1000;
}

function parseSrt(content, fileName = 'SRT') {
  const normalized = String(content).replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').trim();
  if (!normalized) throw new Error(`${fileName} không có nội dung timeline.`);
  const cues = [];
  for (const block of normalized.split(/\n{2,}/)) {
    const lines = block.split('\n');
    const timelineIndex = lines.findIndex((line) => line.includes('-->'));
    if (timelineIndex < 0) continue;
    const timeline = lines[timelineIndex].match(/(\d+:\d{2}:\d{2}[,.]\d{3})\s*-->\s*(\d+:\d{2}:\d{2}[,.]\d{3})/);
    if (!timeline) continue;
    const start = parseSrtTimestamp(timeline[1]);
    const end = parseSrtTimestamp(timeline[2]);
    if (start === null || end === null || end <= start) continue;
    cues.push({ start, end, text: lines.slice(timelineIndex + 1).join('\n').trim() || ' ' });
  }
  cues.sort((a, b) => a.start - b.start || a.end - b.end);
  if (!cues.length) throw new Error(`${fileName} không có mốc thời gian SRT hợp lệ.`);
  return cues;
}

async function readSrt(filePath) {
  return parseSrt(await fsp.readFile(filePath, 'utf8'), path.basename(filePath));
}

function indexByOrder(files) {
  const map = new Map();
  const duplicates = [];
  for (const file of files) {
    if (file.order === null) continue;
    if (map.has(file.order)) duplicates.push(file.name);
    else map.set(file.order, file);
  }
  return { map, duplicates };
}

async function scanAudioFolders(audioFolder, mediaFolder) {
  if (!audioFolder || !mediaFolder) throw new Error('Vui lòng chọn đủ thư mục âm thanh và thư mục video/hình ảnh.');

  const [audioFiles, mediaFiles] = await Promise.all([
    listFiles(audioFolder, AUDIO_EXTENSIONS),
    listFiles(mediaFolder, new Set([...VIDEO_EXTENSIONS, ...IMAGE_EXTENSIONS]))
  ]);

  const { map: mediaByOrder, duplicates: duplicateMedia } = indexByOrder(mediaFiles);

  const usedMedia = new Set();
  const pairs = [];
  const unmatchedAudio = [];
  for (const audio of audioFiles) {
    if (audio.order === null || !mediaByOrder.has(audio.order)) {
      unmatchedAudio.push(audio.name);
      continue;
    }
    const media = mediaByOrder.get(audio.order);
    usedMedia.add(media.path);
    pairs.push({
      order: audio.order,
      sourceName: audio.name,
      audioName: audio.name,
      audioPath: audio.path,
      mediaName: media.name,
      mediaPath: media.path,
      mediaType: mediaType(media.name),
      timelineLabel: 'Theo thời lượng âm thanh'
    });
  }

  const unmatchedMedia = mediaFiles.filter((file) => !usedMedia.has(file.path)).map((file) => file.name);
  pairs.sort((a, b) => Number(a.order) - Number(b.order) || naturalSort.compare(a.audioName, b.audioName));

  return {
    pairs,
    counts: { source: audioFiles.length, media: mediaFiles.length, matched: pairs.length },
    warnings: { unmatchedSource: unmatchedAudio, unmatchedMedia, duplicateMedia, invalidSrt: [], duplicateSource: [] }
  };
}


async function scanSrtFile(subtitlePath, mediaFolder) {
  if (!subtitlePath || !mediaFolder) throw new Error('Vui lòng chọn file SRT và thư mục video/hình ảnh.');
  const [cues, allMedia] = await Promise.all([
    readSrt(subtitlePath),
    listFiles(mediaFolder, new Set([...VIDEO_EXTENSIONS, ...IMAGE_EXTENSIONS]))
  ]);
  const { map: mediaByOrder, duplicates: duplicateMedia } = indexByOrder(allMedia);
  const mediaFiles = [...mediaByOrder.values()].sort((a, b) => Number(a.order) - Number(b.order) || naturalSort.compare(a.name, b.name));
  const pairCount = Math.min(cues.length, mediaFiles.length);
  const pairs = [];
  const totalSrtDuration = cues.at(-1).end;

  for (let index = 0; index < pairCount; index += 1) {
    const cue = cues[index];
    const media = mediaFiles[index];
    const segmentStart = index === 0 ? 0 : cue.start;
    const segmentEnd = index === pairCount - 1 ? totalSrtDuration : cues[index + 1].start;
    const targetDuration = Math.max(segmentEnd - segmentStart, 0.04);
    pairs.push({
      order: media.order,
      sourceName: `${path.basename(subtitlePath)} • Dòng ${index + 1}`,
      mediaName: media.name,
      mediaPath: media.path,
      mediaType: mediaType(media.name),
      targetDuration,
      segmentStart,
      timelineLabel: `${formatSeconds(segmentStart)} → ${formatSeconds(segmentEnd)}`
    });
  }

  const unmatchedMedia = allMedia.filter((file) => !pairs.some((pair) => pair.mediaPath === file.path)).map((file) => file.name);
  const unusedCues = Math.max(0, cues.length - mediaFiles.length);
  return {
    pairs,
    counts: { source: cues.length, media: allMedia.length, matched: pairs.length },
    warnings: { unmatchedSource: Array.from({ length: unusedCues }, (_item, index) => `Dòng SRT ${mediaFiles.length + index + 1}`), unmatchedMedia, duplicateMedia, invalidSrt: [], duplicateSource: [] }
  };
}

async function scanSrtFolder(subtitleFolder, mediaFolder) {
  if (!subtitleFolder || !mediaFolder) throw new Error('Vui lòng chọn thư mục SRT và thư mục video/hình ảnh.');
  const [subtitleFiles, mediaFiles] = await Promise.all([
    listFiles(subtitleFolder, SUBTITLE_EXTENSIONS),
    listFiles(mediaFolder, new Set([...VIDEO_EXTENSIONS, ...IMAGE_EXTENSIONS]))
  ]);
  const { map: mediaByOrder, duplicates: duplicateMedia } = indexByOrder(mediaFiles);
  const { map: subtitleByOrder, duplicates: duplicateSource } = indexByOrder(subtitleFiles);
  const usedMedia = new Set();
  const pairs = [];
  const unmatchedSource = subtitleFiles.filter((file) => file.order === null).map((file) => file.name);
  const invalidSrt = [];

  for (const subtitle of subtitleByOrder.values()) {
    if (!mediaByOrder.has(subtitle.order)) {
      unmatchedSource.push(subtitle.name);
      continue;
    }
    try {
      const cues = await readSrt(subtitle.path);
      const media = mediaByOrder.get(subtitle.order);
      const targetDuration = cues.at(-1).end;
      usedMedia.add(media.path);
      pairs.push({
        order: subtitle.order,
        sourceName: subtitle.name,
        mediaName: media.name,
        mediaPath: media.path,
        mediaType: mediaType(media.name),
        targetDuration,
        timelineLabel: `00:00:00,000 → ${formatSeconds(targetDuration)}`
      });
    } catch (error) {
      invalidSrt.push(error.message);
    }
  }
  pairs.sort((a, b) => Number(a.order) - Number(b.order) || naturalSort.compare(a.sourceName, b.sourceName));
  const unmatchedMedia = mediaFiles.filter((file) => !usedMedia.has(file.path)).map((file) => file.name);
  return {
    pairs,
    counts: { source: subtitleFiles.length, media: mediaFiles.length, matched: pairs.length },
    warnings: { unmatchedSource, unmatchedMedia, duplicateMedia, invalidSrt, duplicateSource }
  };
}

async function scanProject(settings) {
  if (settings.timingMode === 'audio') return scanAudioFolders(settings.audioFolder, settings.mediaFolder);
  if (settings.timingMode === 'srt' && settings.subtitleMode === 'file') return scanSrtFile(settings.subtitlePath, settings.mediaFolder);
  if (settings.timingMode === 'srt' && settings.subtitleMode === 'folder') return scanSrtFolder(settings.subtitlePath, settings.mediaFolder);
  throw new Error('Vui lòng chọn nguồn thời lượng là âm thanh hoặc SRT.');
}

ipcMain.handle('choose-folder', async (_event, kind) => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: kind === 'audio' ? 'Chọn thư mục âm thanh' : kind === 'media' ? 'Chọn thư mục video hoặc hình ảnh' : kind === 'subtitle' ? 'Chọn thư mục SRT đánh số' : 'Chọn thư mục xuất',
    properties: ['openDirectory', 'createDirectory']
  });
  return result.canceled ? null : result.filePaths[0];
});

ipcMain.handle('choose-srt-file', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Chọn file SRT làm nguồn timeline',
    properties: ['openFile'],
    filters: [{ name: 'Phụ đề SubRip', extensions: ['srt'] }]
  });
  return result.canceled ? null : result.filePaths[0];
});

ipcMain.handle('scan-project', async (_event, settings) => scanProject(settings));
ipcMain.handle('detect-hardware', async () => getHardwareInfo());

ipcMain.handle('open-folder', async (_event, folderPath) => {
  if (folderPath) return shell.openPath(folderPath);
  return '';
});

ipcMain.handle('cancel-processing', () => {
  cancelRequested = true;
  for (const child of activeProcesses) child.kill();
  return true;
});

function sendProgress(payload) {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('processing-progress', payload);
}

function runProcess(executable, args, expectedDuration, onProgress) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { windowsHide: true });
    activeProcesses.add(child);
    let stderr = '';
    let stdoutBuffer = '';

    child.stdout.on('data', (chunk) => {
      stdoutBuffer += chunk.toString();
      const lines = stdoutBuffer.split(/\r?\n/);
      stdoutBuffer = lines.pop() || '';
      for (const line of lines) {
        if (line.startsWith('out_time_ms=')) {
          const seconds = Number(line.slice(12)) / 1_000_000;
          if (Number.isFinite(seconds) && expectedDuration > 0) onProgress(Math.min(seconds / expectedDuration, 1));
        }
      }
    });

    child.stderr.on('data', (chunk) => {
      stderr = (stderr + chunk.toString()).slice(-12000);
    });

    child.on('error', (error) => {
      activeProcesses.delete(child);
      reject(error);
    });
    child.on('close', (code) => {
      activeProcesses.delete(child);
      if (cancelRequested) return reject(new Error('Đã hủy tác vụ.'));
      if (code === 0) resolve();
      else reject(new Error(`FFmpeg dừng với mã ${code}.\n${stderr.trim()}`));
    });
  });
}

function probeDuration(filePath) {
  return new Promise((resolve, reject) => {
    const args = ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1', filePath];
    const child = spawn(ffprobePath(), args, { windowsHide: true });
    let output = '';
    let error = '';
    child.stdout.on('data', (chunk) => { output += chunk.toString(); });
    child.stderr.on('data', (chunk) => { error += chunk.toString(); });
    child.on('error', reject);
    child.on('close', (code) => {
      const duration = Number.parseFloat(output.trim());
      if (code === 0 && Number.isFinite(duration) && duration > 0) resolve(duration);
      else reject(new Error(`Không đọc được thời lượng: ${path.basename(filePath)}. ${error.trim()}`));
    });
  });
}

function safeBaseName(value) {
  const cleaned = String(value || 'video-da-noi').replace(/[<>:"/\\|?*\x00-\x1F]/g, '-').replace(/[. ]+$/g, '').trim();
  return cleaned || 'video-da-noi';
}

function formatSeconds(seconds) {
  const totalMilliseconds = Math.max(0, Math.round(seconds * 1000));
  const hours = Math.floor(totalMilliseconds / 3_600_000);
  const minutes = Math.floor((totalMilliseconds % 3_600_000) / 60_000);
  const secs = Math.floor((totalMilliseconds % 60_000) / 1000);
  const milliseconds = totalMilliseconds % 1000;
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')},${String(milliseconds).padStart(3, '0')}`;
}

async function uniqueOutputPath(folder, baseName) {
  let candidate = path.join(folder, `${baseName}.mp4`);
  let number = 2;
  while (fs.existsSync(candidate)) {
    candidate = path.join(folder, `${baseName} (${number}).mp4`);
    number += 1;
  }
  return candidate;
}

function formatOrder(order, total) {
  const width = Math.max(3, String(total).length);
  return String(order).padStart(width, '0');
}

async function renderPair(pair, outputPath, settings, onFileProgress) {
  const usingAudio = settings.timingMode === 'audio';
  const targetDuration = usingAudio ? await probeDuration(pair.audioPath) : pair.targetDuration;
  let mediaDuration = null;
  if (pair.mediaType === 'video') mediaDuration = await probeDuration(pair.mediaPath);

  const [width, height] = settings.resolution.split('x').map(Number);
  let videoFilter = `scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=30`;
  const args = ['-y'];

  if (pair.mediaType === 'image') {
    args.push('-loop', '1', '-framerate', '30', '-i', pair.mediaPath);
  } else {
    args.push('-i', pair.mediaPath);
    if (mediaDuration < targetDuration) {
      const stretchRatio = targetDuration / mediaDuration;
      videoFilter = `setpts=${stretchRatio.toFixed(9)}*PTS,${videoFilter}`;
    }
  }
  if (usingAudio) args.push('-i', pair.audioPath);

  videoFilter += ',format=yuv420p';

  args.push(
    '-filter_complex', `[0:v]${videoFilter}[v]`,
    '-map', '[v]'
  );
  if (usingAudio) args.push('-map', '1:a:0');
  args.push(
    '-t', targetDuration.toFixed(6),
    ...videoEncoderArgs(settings.encoderInfo, settings.crf)
  );
  if (usingAudio) args.push('-c:a', 'aac', '-b:a', '192k', '-ar', '48000', '-ac', '2');
  args.push(
    '-movflags', '+faststart', '-avoid_negative_ts', 'make_zero',
    '-progress', 'pipe:1', '-nostats', outputPath
  );

  await runProcess(ffmpegPath(), args, targetDuration, onFileProgress);

  return targetDuration;
}

function concatListLine(filePath) {
  return `file '${filePath.replace(/\\/g, '/').replace(/'/g, "'\\''")}'`;
}

async function concatenateVideos(files, outputPath, tempFolder, totalDuration, startPercent = 92, endPercent = 100) {
  const listPath = path.join(tempFolder, 'concat-list.txt');
  await fsp.writeFile(listPath, files.map(concatListLine).join('\n'), 'utf8');
  const args = [
    '-y', '-f', 'concat', '-safe', '0', '-i', listPath,
    '-c', 'copy', '-movflags', '+faststart',
    '-progress', 'pipe:1', '-nostats', outputPath
  ];
  await runProcess(ffmpegPath(), args, totalDuration, (progress) => {
    sendProgress({ phase: 'concat', percent: startPercent + progress * (endPercent - startPercent), current: files.length, total: files.length, file: '', message: 'Đang nối các video...' });
  });
}

async function startProcessing(settings) {
  if (processing) throw new Error('Một tác vụ khác đang chạy.');
  processing = true;
  cancelRequested = false;
  let tempFolder = null;

  try {
    if (!settings.outputFolder) throw new Error('Vui lòng chọn thư mục xuất.');
    if (!['separate', 'concat'].includes(settings.mode)) throw new Error('Chế độ xuất không hợp lệ.');
    if (!['auto', 'gpu', 'cpu'].includes(settings.encoderMode || 'auto')) throw new Error('Chế độ tăng tốc không hợp lệ.');
    if (!['1920x1080', '1080x1920', '1280x720', '720x1280'].includes(settings.resolution)) throw new Error('Độ phân giải không hợp lệ.');
    if (!['audio', 'srt'].includes(settings.timingMode)) throw new Error('Nguồn thời lượng không hợp lệ.');
    if (settings.timingMode === 'audio' && (!settings.audioFolder || !settings.mediaFolder)) {
      throw new Error('Chế độ âm thanh cần thư mục âm thanh và thư mục video/hình ảnh.');
    }
    if (settings.timingMode === 'srt') {
      if (!['folder', 'file'].includes(settings.subtitleMode)) throw new Error('Hãy chọn một file SRT hoặc thư mục SRT.');
      if (!settings.subtitlePath || !fs.existsSync(settings.subtitlePath)) throw new Error('Nguồn SRT không hợp lệ hoặc không còn tồn tại.');
      if (settings.subtitleMode === 'file' && path.extname(settings.subtitlePath).toLowerCase() !== '.srt') throw new Error('File timeline phải có định dạng .srt.');
    }
    sendProgress({ phase: 'detect', percent: 0, current: 0, total: 0, file: '', message: 'Đang nhận diện bộ mã hóa CPU/GPU...' });
    settings.encoderInfo = await resolveEncoder(settings.encoderMode || 'auto');
    await fsp.mkdir(settings.outputFolder, { recursive: true });

    const scan = await scanProject(settings);
    if (!scan.pairs.length) throw new Error('Không tìm thấy cặp nguồn thời lượng và video/hình ảnh phù hợp.');

    const outputs = new Array(scan.pairs.length);
    let renderFolder = settings.outputFolder;
    if (settings.mode === 'concat') {
      tempFolder = await fsp.mkdtemp(path.join(os.tmpdir(), 'dong-bo-video-'));
      renderFolder = tempFolder;
    }

    const renderItems = [];
    for (let index = 0; index < scan.pairs.length; index += 1) {
      const pair = scan.pairs[index];
      const order = formatOrder(pair.order, scan.pairs.length);
      const sourceBase = path.basename(pair.sourceName, path.extname(pair.sourceName)).replace(/\s*•.*$/, '');
      const fileName = `${order}-${safeBaseName(sourceBase)}`;
      const outputPath = settings.mode === 'separate'
        ? await uniqueOutputPath(renderFolder, fileName)
        : path.join(renderFolder, `${String(index + 1).padStart(6, '0')}.mp4`);
      outputs[index] = outputPath;
      renderItems.push({ pair, outputPath });
    }

    const cpuCount = os.cpus()?.length || 2;
    const concurrency = Math.min(renderItems.length, settings.encoderInfo.hardware ? 2 : (cpuCount >= 4 ? 2 : 1));
    const durations = new Array(renderItems.length).fill(0);
    const fileProgress = new Array(renderItems.length).fill(0);
    const renderWeight = settings.mode === 'concat' ? 92 : 100;
    let nextIndex = 0;
    let completed = 0;

    const worker = async () => {
      while (true) {
        if (cancelRequested) throw new Error('Đã hủy tác vụ.');
        const index = nextIndex;
        nextIndex += 1;
        if (index >= renderItems.length) return;
        const item = renderItems[index];
        durations[index] = await renderPair(item.pair, item.outputPath, settings, (progress) => {
          fileProgress[index] = progress;
          const overall = fileProgress.reduce((sum, value) => sum + value, 0) / renderItems.length;
          sendProgress({
            phase: 'render',
            percent: overall * renderWeight,
            current: completed,
            total: renderItems.length,
            file: item.pair.sourceName,
            message: `Đang xử lý song song bằng ${settings.encoderInfo.label} • ${completed}/${renderItems.length} hoàn tất`
          });
        });
        fileProgress[index] = 1;
        completed += 1;
      }
    };

    const workers = Array.from({ length: concurrency }, () => worker());
    try {
      await Promise.all(workers);
    } catch (error) {
      for (const child of activeProcesses) child.kill();
      await Promise.allSettled(workers);
      throw error;
    }
    const totalDuration = durations.reduce((sum, value) => sum + value, 0);

    let finalOutput = null;
    if (settings.mode === 'concat') {
      finalOutput = await uniqueOutputPath(settings.outputFolder, safeBaseName(settings.outputName));
      await concatenateVideos(outputs, finalOutput, tempFolder, totalDuration);
    }

    sendProgress({ phase: 'done', percent: 100, current: scan.pairs.length, total: scan.pairs.length, file: '', message: 'Hoàn tất!' });
    return {
      success: true,
      processed: scan.pairs.length,
      outputFolder: settings.outputFolder,
      finalOutput,
      encoder: settings.encoderInfo.label,
      concurrency,
      warnings: scan.warnings
    };
  } finally {
    processing = false;
    if (tempFolder) await fsp.rm(tempFolder, { recursive: true, force: true }).catch(() => {});
  }
}

ipcMain.handle('start-processing', (_event, settings) => startProcessing(settings));
