const sheetUrlInput = document.getElementById('sheetUrl');
const startSecondInput = document.getElementById('startSecond');
const startBtn = document.getElementById('startBtn');
const stopBtn = document.getElementById('stopBtn');

// Default sheet URL
const DEFAULT_SHEET_URL = 'https://docs.google.com/spreadsheets/d/1uiHk8KEp-Yc5tj8l6RnY2dEGZwsG2aMPhqiO5IP5mq0/edit?gid=0#gid=0';

// Load saved values on popup open
document.addEventListener('DOMContentLoaded', async () => {
  const { sheetUrl, startSecond } = await chrome.storage.local.get(['sheetUrl', 'startSecond']);
  
  // Set default sheet URL if none exists, otherwise use saved value
  if (sheetUrl) {
    sheetUrlInput.value = sheetUrl;
  } else {
    sheetUrlInput.value = DEFAULT_SHEET_URL;
    // Save the default URL to storage
    await chrome.storage.local.set({ sheetUrl: DEFAULT_SHEET_URL });
  }
  
  if (startSecond != null && startSecond !== '') startSecondInput.value = String(startSecond).replace(',', '.');
});

startBtn.addEventListener('click', async () => {
  const sheetUrl = sheetUrlInput.value.trim();
  const raw = (startSecondInput.value.trim() || '2').replace(',', '.');
  const startSecond = parseFloat(raw);
  if (!sheetUrl) return alert('Enter sheet URL');
  if (Number.isNaN(startSecond)) return alert('Start Second must be a number (e.g. 2 or 2.5)');

  await chrome.storage.local.set({ sheetUrl, startSecond, manualStart: true });
  chrome.runtime.sendMessage({ action: 'manualStart' });
});

stopBtn.addEventListener('click', async () => {
  await chrome.storage.local.set({ manualStart: false, statusOverride: 'Off' });
  chrome.runtime.sendMessage({ action: 'manualStop' });
});
