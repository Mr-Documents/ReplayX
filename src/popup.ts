import './popup.css';
import { SessionData } from './types';

// UI Elements
const startBtn = document.getElementById('start-btn') as HTMLButtonElement;
const stopBtn = document.getElementById('stop-btn') as HTMLButtonElement;
const pauseBtn = document.getElementById('pause-btn') as HTMLButtonElement;
const resumeBtn = document.getElementById('resume-btn') as HTMLButtonElement;
const sessionsContainer = document.getElementById('sessions') as HTMLDivElement;
const statusText = document.getElementById('status') as HTMLSpanElement;
const replayControls = document.getElementById('replay-controls') as HTMLDivElement;
const speedControl = document.getElementById('speed-control') as HTMLInputElement;
const speedValue = document.getElementById('speed-value') as HTMLSpanElement;
const timeline = document.getElementById('timeline') as HTMLDivElement;
const progressBar = document.getElementById('progress-bar') as HTMLDivElement;

// State
let currentState = {
  isRecording: false,
  isReplaying: false,
  replaySpeed: 1,
  sessions: [] as SessionData[]
};

function updateUI(updates: Partial<typeof currentState>) {
  currentState = { ...currentState, ...updates };

  // Recording controls
  startBtn.disabled = currentState.isRecording || currentState.isReplaying;
  stopBtn.disabled = !currentState.isRecording;
  pauseBtn.disabled = !currentState.isRecording && !currentState.isReplaying;
  resumeBtn.disabled = !currentState.isRecording && !currentState.isReplaying;

  // Status
  if (currentState.isReplaying) {
    statusText.textContent = 'Replaying...';
    statusText.style.color = '#38a169';
  } else if (currentState.isRecording) {
    statusText.textContent = 'Recording...';
    statusText.style.color = '#e53e3e';
  } else {
    statusText.textContent = 'Idle';
    statusText.style.color = '#718096';
  }

  // Replay controls
  replayControls.style.display = currentState.isReplaying ? 'block' : 'none';
  speedControl.value = currentState.replaySpeed.toString();
  speedValue.textContent = `${currentState.replaySpeed}x`;
}

function loadSessions() {
  chrome.runtime.sendMessage({ action: 'GET_SESSIONS' }, (response) => {
    if (response && response.sessions) {
      currentState.sessions = response.sessions;
      renderSessions(response.sessions);
    } else if (response.error) {
      console.error('Error loading sessions:', response.error);
      sessionsContainer.innerHTML = '<span style="color: #e53e3e;">Error loading sessions</span>';
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
    const duration = session.metadata?.duration ? `${(session.metadata.duration / 1000).toFixed(1)}s` : 'Unknown';

    let displayUrl = session.url;
    try {
      if (session.url) {
        const url = new URL(session.url);
        displayUrl = url.pathname === '/' ? url.hostname : url.pathname;
      }
    } catch (e) {
      // Keep original string if invalid URL
    }

    el.innerHTML = `
      <div class="session-info">
        <strong>${date}</strong><br>
        URL: ${displayUrl}<br>
        Events: ${eventCount} | Duration: ${duration}
      </div>
      <div class="session-actions">
        <button class="replay-btn" data-id="${session.id}">Replay</button>
        <button class="export-btn" data-id="${session.id}">Export</button>
        <button class="delete-btn" data-id="${session.id}">Delete</button>
      </div>
    `;

    // Event listeners
    const replayBtn = el.querySelector('.replay-btn') as HTMLButtonElement;
    const exportBtn = el.querySelector('.export-btn') as HTMLButtonElement;
    const deleteBtn = el.querySelector('.delete-btn') as HTMLButtonElement;

    replayBtn.addEventListener('click', () => replaySession(session.id));
    exportBtn.addEventListener('click', () => exportSession(session.id));
    deleteBtn.addEventListener('click', () => deleteSession(session.id, el));

    sessionsContainer.appendChild(el);
  });
}

function replaySession(sessionId: string) {
  const speed = parseFloat(speedControl.value);
  chrome.runtime.sendMessage({
    action: 'REPLAY_SESSION',
    sessionId,
    speed
  }, (res) => {
    if (res && res.success) {
      updateUI({ isReplaying: true });
      window.close(); // Close popup when replay starts
    } else {
      alert('Failed to start replay: ' + (res?.error || 'Unknown error'));
    }
  });
}

function exportSession(sessionId: string) {
  chrome.runtime.sendMessage({ action: 'EXPORT_SESSION', sessionId }, (res) => {
    if (!res || !res.success) {
      alert('Failed to export session: ' + (res?.error || 'Unknown error'));
    }
  });
}

function deleteSession(sessionId: string, element: HTMLElement) {
  if (!confirm('Are you sure you want to delete this session?')) return;

  chrome.runtime.sendMessage({ action: 'DELETE_SESSION', sessionId }, (res) => {
    if (res && res.success) {
      element.remove();
      loadSessions(); // Refresh the list
    } else {
      alert('Failed to delete session: ' + (res?.error || 'Unknown error'));
    }
  });
}

// Event listeners
startBtn.addEventListener('click', () => {
  updateUI({ isRecording: true });
  chrome.runtime.sendMessage({ action: 'START_RECORDING' }, (res) => {
    if (!res || !res.success) {
      updateUI({ isRecording: false });
      alert('Failed to start recording: ' + (res?.error || 'Make sure you are on a valid webpage.'));
    }
  });
});

stopBtn.addEventListener('click', () => {
  updateUI({ isRecording: false });
  chrome.runtime.sendMessage({ action: 'STOP_RECORDING' }, (res) => {
    if (res && res.success) {
      loadSessions();
    } else {
      alert('Failed to stop recording: ' + (res?.error || 'Unknown error'));
    }
  });
});

pauseBtn.addEventListener('click', () => {
  const action = currentState.isReplaying ? 'PAUSE_REPLAY' : 'PAUSE_RECORDING';
  chrome.runtime.sendMessage({ action }, (res) => {
    if (res && res.success) {
      statusText.textContent = currentState.isReplaying ? 'Replay Paused' : 'Recording Paused';
      statusText.style.color = '#ecc94b'; // Yellow for paused
    }
  });
});

resumeBtn.addEventListener('click', () => {
  const action = currentState.isReplaying ? 'RESUME_REPLAY' : 'RESUME_RECORDING';
  chrome.runtime.sendMessage({ action }, (res) => {
    if (res && res.success) {
      if (currentState.isReplaying) {
        statusText.textContent = 'Replaying...';
        statusText.style.color = '#38a169';
      } else {
        statusText.textContent = 'Recording...';
        statusText.style.color = '#e53e3e';
      }
    }
  });
});

speedControl.addEventListener('input', () => {
  const speed = parseFloat(speedControl.value);
  speedValue.textContent = `${speed}x`;
  chrome.runtime.sendMessage({ action: 'SET_REPLAY_SPEED', speed });
});

// Import functionality
const importBtn = document.getElementById('import-btn') as HTMLButtonElement;
const importInput = document.getElementById('import-input') as HTMLInputElement;

importBtn.addEventListener('click', () => {
  importInput.click();
});

importInput.addEventListener('change', (e) => {
  const file = (e.target as HTMLInputElement).files?.[0];
  if (!file) return;

  const reader = new FileReader();
  reader.onload = (e) => {
    try {
      const sessionData = JSON.parse(e.target?.result as string);
      chrome.runtime.sendMessage({ action: 'IMPORT_SESSION', sessionData }, (res) => {
        if (res && res.success) {
          loadSessions();
          alert('Session imported successfully!');
        } else {
          alert('Failed to import session: ' + (res?.error || 'Invalid file format'));
        }
      });
    } catch (error) {
      alert('Invalid JSON file');
    }
  };
  reader.readAsText(file);
});

// Initial setup
chrome.runtime.sendMessage({ action: 'GET_STATE' }, (state) => {
  if (state) {
    updateUI({
      isRecording: state.isRecording || false,
      isReplaying: !!state.activeReplaySession,
      replaySpeed: state.replaySpeed || 1
    });
  }
});

loadSessions();

// Periodic state updates to handle popup reloads or missed messages
setInterval(() => {
  chrome.runtime.sendMessage({ action: 'GET_STATE' }, (state) => {
    if (state) {
      updateUI({
        isRecording: state.isRecording || false,
        isReplaying: !!state.activeReplaySession,
        replaySpeed: state.replaySpeed || 1
      });
    }
  });
}, 1000);
