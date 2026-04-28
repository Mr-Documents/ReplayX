import './popup.css';
import { SessionData } from './types';

const startBtn = document.getElementById('start-btn') as HTMLButtonElement;
const stopBtn = document.getElementById('stop-btn') as HTMLButtonElement;
const sessionsContainer = document.getElementById('sessions') as HTMLDivElement;
const statusText = document.getElementById('status') as HTMLSpanElement;

function updateUI(isRecording: boolean) {
  startBtn.disabled = isRecording;
  stopBtn.disabled = !isRecording;
  statusText.textContent = isRecording ? 'Recording...' : 'Idle';
  statusText.style.color = isRecording ? '#e53e3e' : '#718096';
}

function loadSessions() {
  chrome.runtime.sendMessage({ action: 'GET_SESSIONS' }, (response) => {
    if (response && response.sessions) {
      renderSessions(response.sessions);
    }
  });
}

function renderSessions(sessions: SessionData[]) {
  sessionsContainer.innerHTML = '';
  if (sessions.length === 0) {
    sessionsContainer.innerHTML = '<span style="font-size: 12px; color: #a0aec0;">No sessions recorded yet.</span>';
    return;
  }

  // Sort by newest first
  sessions.sort((a, b) => b.startTime - a.startTime);

  sessions.forEach(session => {
    const el = document.createElement('div');
    el.className = 'session-item';
    
    const date = new Date(session.startTime).toLocaleString();
    const eventCount = session.events.length;
    
    el.innerHTML = `
      <div class="session-info">
        <strong>${date}</strong><br>
        URL: ${new URL(session.url).pathname}<br>
        Events: ${eventCount}
      </div>
      <button class="replay-btn" data-id="${session.id}">Replay Session</button>
    `;
    
    const replayBtn = el.querySelector('.replay-btn');
    if (replayBtn) {
      replayBtn.addEventListener('click', () => {
        chrome.runtime.sendMessage({ action: 'REPLAY_SESSION', sessionId: session.id }, res => {
           if (res && res.success) {
               window.close(); // Close popup when replay starts
           }
        });
      });
    }
    
    sessionsContainer.appendChild(el);
  });
}

// Initial state fetch
chrome.runtime.sendMessage({ action: 'GET_STATE' }, (state) => {
  if (state) {
    updateUI(state.isRecording || false);
  }
});
loadSessions();

startBtn.addEventListener('click', () => {
  updateUI(true);
  chrome.runtime.sendMessage({ action: 'START_RECORDING' }, (res) => {
      if (!res || !res.success) {
          updateUI(false);
          alert('Failed to start recording. Make sure you are on a valid webpage.');
      }
  });
});

stopBtn.addEventListener('click', () => {
  updateUI(false);
  chrome.runtime.sendMessage({ action: 'STOP_RECORDING' }, () => {
    loadSessions();
  });
});
