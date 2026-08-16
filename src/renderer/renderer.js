const state = {
  timingMode: 'audio',
  audioFolder: '',
  mediaFolder: '',
  outputFolder: '',
  subtitleMode: 'none',
  subtitlePath: '',
  scan: null,
  running: false
};

const elements = {
  appShell: document.querySelector('.app-shell'),
  audioFolderRow: document.querySelector('#audioFolderRow'),
  subtitleFolderRow: document.querySelector('#subtitleFolderRow'),
  audioPath: document.querySelector('#audioPath'),
  mediaPath: document.querySelector('#mediaPath'),
  outputPath: document.querySelector('#outputPath'),
  subtitlePath: document.querySelector('#subtitlePath'),
  pickSrtFileButton: document.querySelector('#pickSrtFileButton'),
  clearSrtButton: document.querySelector('#clearSrtButton'),
  scanButton: document.querySelector('#scanButton'),
  scanSummary: document.querySelector('#scanSummary'),
  pairCard: document.querySelector('#pairCard'),
  pairCount: document.querySelector('#pairCount'),
  pairRows: document.querySelector('#pairRows'),
  sourceHeader: document.querySelector('#sourceHeader'),
  warningBox: document.querySelector('#warningBox'),
  syncNote: document.querySelector('#syncNote'),
  outputNameField: document.querySelector('#outputNameField'),
  outputName: document.querySelector('#outputName'),
  resolution: document.querySelector('#resolution'),
  quality: document.querySelector('#quality'),
  encoderMode: document.querySelector('#encoderMode'),
  hardwareStatus: document.querySelector('#hardwareStatus'),
  startButton: document.querySelector('#startButton'),
  cancelButton: document.querySelector('#cancelButton'),
  openOutputButton: document.querySelector('#openOutputButton'),
  progressCard: document.querySelector('#progressCard'),
  progressMessage: document.querySelector('#progressMessage'),
  progressPercent: document.querySelector('#progressPercent'),
  progressBar: document.querySelector('#progressBar'),
  toast: document.querySelector('#toast')
};

let resizeFrame = null;

function fitWindowToContent() {
  if (resizeFrame !== null) cancelAnimationFrame(resizeFrame);
  resizeFrame = requestAnimationFrame(() => {
    resizeFrame = null;
    const contentHeight = Math.ceil(elements.appShell.getBoundingClientRect().height);
    window.syncApp.resizeToContent(contentHeight);
  });
}

new ResizeObserver(fitWindowToContent).observe(elements.appShell);
window.addEventListener('load', fitWindowToContent, { once: true });

let hardwareInfo = null;

function updateHardwareStatus() {
  const mode = elements.encoderMode.value;
  if (!hardwareInfo) {
    elements.hardwareStatus.textContent = 'Đang nhận diện phần cứng...';
    return;
  }
  if (mode === 'cpu') elements.hardwareStatus.textContent = 'Sử dụng CPU • tương thích cao';
  else if (mode === 'gpu' && hardwareInfo.available) elements.hardwareStatus.textContent = `Bắt buộc dùng ${hardwareInfo.label}`;
  else if (mode === 'gpu') elements.hardwareStatus.textContent = 'Không tìm thấy GPU encode tương thích';
  else elements.hardwareStatus.textContent = hardwareInfo.available ? `Auto sẽ dùng ${hardwareInfo.label}` : 'Auto sẽ dùng CPU';
}

elements.encoderMode.addEventListener('change', updateHardwareStatus);
window.syncApp.detectHardware()
  .then((info) => {
    hardwareInfo = info;
    updateHardwareStatus();
  })
  .catch(() => {
    hardwareInfo = { available: false };
    elements.hardwareStatus.textContent = 'Không nhận diện được GPU • Auto dùng CPU';
  });

function showToast(message, error = false) {
  elements.toast.textContent = message;
  elements.toast.classList.toggle('error', error);
  elements.toast.classList.remove('hidden');
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => elements.toast.classList.add('hidden'), 5500);
}

function invalidateScan() {
  state.scan = null;
  elements.pairCard.classList.add('hidden');
}

function updateTimingMode(mode) {
  state.timingMode = mode;
  const useSrt = mode === 'srt';
  elements.audioFolderRow.classList.toggle('hidden', useSrt);
  elements.subtitleFolderRow.classList.toggle('hidden', !useSrt);
  elements.sourceHeader.textContent = useSrt ? 'Nguồn SRT' : 'Âm thanh';
  elements.scanSummary.textContent = useSrt
    ? 'Chế độ hiện tại chỉ cần SRT + Video/Ảnh, không cần âm thanh.'
    : 'Chế độ hiện tại chỉ cần Âm thanh + Video/Ảnh.';
  elements.syncNote.textContent = useSrt
    ? 'SRT chỉ dùng để căn thời lượng và chuyển media; chữ phụ đề không được thêm vào video.'
    : 'Video dài hơn voice sẽ được cắt; video ngắn hơn được đổi tốc độ; ảnh giữ suốt thời lượng voice.';
  invalidateScan();
}

document.querySelectorAll('input[name="timingMode"]').forEach((radio) => {
  radio.addEventListener('change', () => {
    if (radio.checked) updateTimingMode(radio.value);
  });
});

function setPath(kind, folderPath) {
  if (kind === 'subtitle') {
    state.subtitleMode = 'folder';
    state.subtitlePath = folderPath;
    elements.subtitlePath.textContent = `Thư mục SRT: ${folderPath}`;
    elements.subtitlePath.title = folderPath;
    elements.clearSrtButton.classList.remove('hidden');
    invalidateScan();
    return;
  }
  state[`${kind}Folder`] = folderPath;
  elements[`${kind}Path`].textContent = folderPath || 'Chưa chọn thư mục';
  elements[`${kind}Path`].title = folderPath || '';
  if (kind !== 'output') invalidateScan();
}

document.querySelectorAll('[data-pick]').forEach((button) => {
  button.addEventListener('click', async () => {
    const kind = button.dataset.pick;
    const folderPath = await window.syncApp.chooseFolder(kind);
    if (folderPath) setPath(kind, folderPath);
  });
});

elements.pickSrtFileButton.addEventListener('click', async () => {
  const filePath = await window.syncApp.chooseSrtFile();
  if (!filePath) return;
  state.subtitleMode = 'file';
  state.subtitlePath = filePath;
  elements.subtitlePath.textContent = `File SRT: ${filePath}`;
  elements.subtitlePath.title = filePath;
  elements.clearSrtButton.classList.remove('hidden');
  invalidateScan();
});

elements.clearSrtButton.addEventListener('click', () => {
  state.subtitleMode = 'none';
  state.subtitlePath = '';
  elements.subtitlePath.textContent = 'Chưa chọn file hoặc thư mục SRT';
  elements.subtitlePath.title = '';
  elements.clearSrtButton.classList.add('hidden');
  invalidateScan();
});

document.querySelectorAll('input[name="mode"]').forEach((radio) => {
  radio.addEventListener('change', () => {
    if (radio.checked) elements.outputNameField.classList.toggle('hidden', radio.value !== 'concat');
  });
});

function warningText(warnings) {
  const parts = [];
  const sourceLabel = state.timingMode === 'srt' ? 'nguồn/dòng SRT' : 'file âm thanh';
  if (warnings.unmatchedSource?.length) parts.push(`${warnings.unmatchedSource.length} ${sourceLabel} chưa có media tương ứng`);
  if (warnings.unmatchedMedia?.length) parts.push(`${warnings.unmatchedMedia.length} file video/ảnh không được dùng`);
  if (warnings.duplicateMedia?.length) parts.push(`${warnings.duplicateMedia.length} file video/ảnh bị trùng số`);
  if (warnings.duplicateSource?.length) parts.push(`${warnings.duplicateSource.length} file nguồn bị trùng số`);
  if (warnings.invalidSrt?.length) parts.push(`${warnings.invalidSrt.length} file SRT không hợp lệ`);
  return parts.join(' • ');
}

function renderScan(scan) {
  state.scan = scan;
  const sourceLabel = state.timingMode === 'srt' ? (state.subtitleMode === 'file' ? 'dòng SRT' : 'file SRT') : 'âm thanh';
  elements.scanSummary.textContent = `${scan.counts.source} ${sourceLabel} • ${scan.counts.media} video/ảnh • ${scan.counts.matched} cặp sẽ xử lý`;
  elements.pairCount.textContent = `${scan.pairs.length} cặp`;
  elements.pairRows.replaceChildren();
  scan.pairs.forEach((pair) => {
    const row = document.createElement('tr');
    const values = [pair.order, pair.sourceName, pair.mediaName, pair.timelineLabel, pair.mediaType === 'image' ? 'Hình ảnh' : 'Video'];
    values.forEach((value, index) => {
      const cell = document.createElement('td');
      cell.textContent = value;
      cell.title = value;
      if (index === 4) cell.className = 'type-pill';
      row.appendChild(cell);
    });
    elements.pairRows.appendChild(row);
  });
  const warning = warningText(scan.warnings);
  elements.warningBox.textContent = warning ? `Lưu ý: ${warning}.` : '';
  elements.warningBox.classList.toggle('hidden', !warning);
  elements.pairCard.classList.remove('hidden');
}

function validateSources() {
  if (!state.mediaFolder) return 'Vui lòng chọn thư mục video/hình ảnh.';
  if (state.timingMode === 'audio' && !state.audioFolder) return 'Vui lòng chọn thư mục âm thanh.';
  if (state.timingMode === 'srt' && (!state.subtitlePath || state.subtitleMode === 'none')) return 'Vui lòng chọn một file SRT hoặc thư mục SRT.';
  return '';
}

async function scan() {
  const sourceError = validateSources();
  if (sourceError) {
    showToast(sourceError, true);
    return false;
  }
  elements.scanButton.disabled = true;
  elements.scanButton.textContent = 'Đang kiểm tra...';
  try {
    const result = await window.syncApp.scanProject({
      timingMode: state.timingMode,
      audioFolder: state.audioFolder,
      mediaFolder: state.mediaFolder,
      subtitleMode: state.subtitleMode,
      subtitlePath: state.subtitlePath
    });
    renderScan(result);
    if (!result.pairs.length) showToast('Không tìm thấy cặp dữ liệu nào phù hợp.', true);
    return result.pairs.length > 0;
  } catch (error) {
    showToast(error.message, true);
    return false;
  } finally {
    elements.scanButton.disabled = false;
    elements.scanButton.textContent = 'Kiểm tra & ghép cặp';
  }
}

elements.scanButton.addEventListener('click', scan);

function setRunning(running) {
  state.running = running;
  document.querySelectorAll('[data-pick], #pickSrtFileButton, #clearSrtButton, #scanButton, input, select').forEach((control) => { control.disabled = running; });
  elements.startButton.disabled = running;
  elements.startButton.textContent = running ? 'Đang xử lý...' : 'Bắt đầu đồng bộ';
  elements.cancelButton.classList.toggle('hidden', !running);
}

elements.startButton.addEventListener('click', async () => {
  const sourceError = validateSources();
  if (sourceError || !state.outputFolder) {
    showToast(sourceError || 'Vui lòng chọn thư mục kết quả.', true);
    return;
  }
  if (!state.scan && !(await scan())) return;
  if (!state.scan?.pairs.length) return;

  const mode = document.querySelector('input[name="mode"]:checked').value;
  setRunning(true);
  elements.openOutputButton.classList.add('hidden');
  elements.progressCard.classList.remove('hidden');
  elements.progressBar.style.width = '0%';
  elements.progressPercent.textContent = '0%';
  elements.progressMessage.textContent = 'Đang chuẩn bị...';

  try {
    const result = await window.syncApp.start({
      timingMode: state.timingMode,
      audioFolder: state.audioFolder,
      mediaFolder: state.mediaFolder,
      outputFolder: state.outputFolder,
      subtitleMode: state.subtitleMode,
      subtitlePath: state.subtitlePath,
      mode,
      outputName: elements.outputName.value,
      resolution: elements.resolution.value,
      crf: Number(elements.quality.value),
      encoderMode: elements.encoderMode.value
    });
    elements.openOutputButton.classList.remove('hidden');
    showToast(`Hoàn tất ${result.processed} video bằng ${result.encoder}.${result.finalOutput ? `\nĐã tạo: ${result.finalOutput}` : ''}`);
  } catch (error) {
    showToast(error.message || 'Xử lý thất bại.', true);
    elements.progressMessage.textContent = error.message === 'Đã hủy tác vụ.' ? 'Đã hủy' : 'Có lỗi xảy ra';
  } finally {
    setRunning(false);
  }
});

elements.cancelButton.addEventListener('click', async () => {
  elements.cancelButton.disabled = true;
  elements.progressMessage.textContent = 'Đang hủy...';
  await window.syncApp.cancel();
  elements.cancelButton.disabled = false;
});

elements.openOutputButton.addEventListener('click', () => window.syncApp.openFolder(state.outputFolder));

window.syncApp.onProgress((progress) => {
  const percent = Math.max(0, Math.min(100, progress.percent || 0));
  elements.progressBar.style.width = `${percent}%`;
  elements.progressPercent.textContent = `${Math.round(percent)}%`;
  elements.progressMessage.textContent = progress.message;
});
