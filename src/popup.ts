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
const stepBtn = document.getElementById('step-btn') as HTMLButtonElement | null;

// State
let currentState = {
  isRecording: false,
  isPaused: false,
  isReplaying: false,
  isReplayPaused: false,
  replaySpeed: 1,
  sessions: [] as SessionData[]
};

function updateUI(updates: Partial<typeof currentState>) {
  currentState = { ...currentState, ...updates };

  // Recording controls
  startBtn.disabled = currentState.isRecording || currentState.isReplaying;
  stopBtn.disabled = !currentState.isRecording;

  const isAnyActive = currentState.isRecording || currentState.isReplaying;
  const isAnyPaused = currentState.isPaused || currentState.isReplayPaused;

  // Swap visibility: show Resume when active AND paused, Pause when active AND NOT paused
  const showResume = isAnyActive && isAnyPaused;
  const showPause = isAnyActive && !isAnyPaused;

  pauseBtn.style.display = showPause ? 'inline-block' : 'none';
  resumeBtn.style.display = showResume ? 'inline-block' : 'none';

  pauseBtn.disabled = !isAnyActive;
  resumeBtn.disabled = !isAnyActive;

  resumeBtn.textContent = currentState.isRecording ? 'Resume Recording' : 'Resume Replay';

  // Status
  if (currentState.isReplaying && currentState.isReplayPaused) {
    statusText.textContent = 'Replay Paused';
    statusText.style.color = '#ecc94b';
  } else if (currentState.isReplaying) {
    statusText.textContent = 'Replaying...';
    statusText.style.color = '#38a169';
  } else if (currentState.isRecording && currentState.isPaused) {
    statusText.textContent = 'Recording Paused';
    statusText.style.color = '#ecc94b';
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
    const issueCount = session.replayErrors?.length || session.metadata?.replayIssues || 0;
    const pageUrlCount = session.metadata?.pageUrls?.length || 0;

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
        Events: ${eventCount} | Duration: ${duration}${pageUrlCount > 1 ? ` | Pages: ${pageUrlCount}` : ''}${issueCount > 0 ? ` | Issues: ${issueCount}` : ''}
      </div>
      <div class="session-actions">
          <button class="replay-btn" data-id="${session.id}">Replay</button>
          <button class="view-btn" data-id="${session.id}">View</button>
        <button class="export-btn" data-id="${session.id}">Export</button>
        <button class="delete-btn" data-id="${session.id}">Delete</button>
      </div>
    `;

    // Event listeners
    const replayBtn = el.querySelector('.replay-btn') as HTMLButtonElement;
    const exportBtn = el.querySelector('.export-btn') as HTMLButtonElement;
    const deleteBtn = el.querySelector('.delete-btn') as HTMLButtonElement;

    replayBtn.addEventListener('click', () => replaySession(session.id));
    const viewBtn = el.querySelector('.view-btn') as HTMLButtonElement;
    viewBtn.addEventListener('click', () => viewSessionEvents(session.id, el));
    exportBtn.addEventListener('click', () => exportSession(session.id));
    deleteBtn.addEventListener('click', () => deleteSession(session.id, el));

    sessionsContainer.appendChild(el);
  });
}

function viewSessionEvents(sessionId: string, containerEl: HTMLElement) {
  // Request full session from background
  chrome.runtime.sendMessage({ action: 'GET_SESSION', sessionId }, (res) => {
    if (!res || !res.success) {
      alert('Failed to load session details: ' + (res?.error || 'Unknown error'));
      return;
    }

    const session = res.session as SessionData;
    // Create event list element
    let list = containerEl.querySelector('.event-list') as HTMLElement | null;
    if (list) {
      // Toggle
      list.remove();
      return;
    }

    list = document.createElement('div');
    list.className = 'event-list';
    list.style.padding = '8px 10px';
    list.style.background = '#f7fafc';
    list.style.marginTop = '8px';
    list.style.borderRadius = '6px';
    list.style.fontSize = '12px';

    session.events.forEach((ev, idx) => {
      const row = document.createElement('div');
      row.style.display = 'flex';
      row.style.justifyContent = 'space-between';
      row.style.padding = '6px 0';
      row.style.borderBottom = '1px solid #e2e8f0';

      const left = document.createElement('div');
      left.innerHTML = `<strong>${ev.type}</strong> @ ${ev.timestamp}ms<br>${getEventSummary(ev)}`;

      const right = document.createElement('div');
      right.innerHTML = `
        <button class="replay-from" data-idx="${idx}" style="margin-right:6px;">Replay from here</button>
        <button class="step-from" data-idx="${idx}">Step from here</button>
      `;

      right.querySelector('.replay-from')!.addEventListener('click', () => {
        const speed = parseFloat((document.getElementById('speed-control') as HTMLInputElement).value);
        chrome.runtime.sendMessage({ action: 'REPLAY_SESSION', sessionId, speed, startIndex: idx }, (res) => {
          if (res && res.success) {
            window.close();
          } else {
            alert('Failed to start replay: ' + (res?.error || 'Unknown error'));
          }
        });
      });

      right.querySelector('.step-from')!.addEventListener('click', () => {
        const speed = parseFloat((document.getElementById('speed-control') as HTMLInputElement).value);
        chrome.runtime.sendMessage({ action: 'REPLAY_SESSION', sessionId, speed, startIndex: idx, step: true }, (res) => {
          if (res && res.success) {
            window.close();
          } else {
            alert('Failed to start step replay: ' + (res?.error || 'Unknown error'));
          }
        });
      });

      row.appendChild(left);
      row.appendChild(right);
      list!.appendChild(row);
    });

    containerEl.appendChild(list);
  });
}

function getEventSummary(ev: any): string {
  if (!ev || !ev.payload) return '';

  switch (ev.type) {
    case 'Click':
    case 'DoubleClick':
      return `Target: ${ev.payload.selector || 'unknown'}${ev.payload.textSnippet ? ` | text: ${ev.payload.textSnippet.slice(0, 40)}` : ''}`;
    case 'Input':
    case 'Change':
      return `Target: ${ev.payload.selector || 'unknown'} | value: ${String(ev.payload.value).slice(0, 40)}`;
    case 'Submit':
      return `Form: ${ev.payload.selector || 'unknown'} | action: ${ev.payload.formAction || 'n/a'}`;
    case 'Network':
      return `Network: ${ev.payload.method} ${ev.payload.url} | status: ${ev.payload.responseStatus}`;
    case 'Navigation':
      return `Navigate to ${ev.payload.url}`;
    default:
      return ev.payload.selector ? `Target: ${ev.payload.selector}` : '';
  }
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
    if (res && res.success) loadState();
  });
});

resumeBtn.addEventListener('click', () => {
  const action = currentState.isReplaying ? 'RESUME_REPLAY' : 'RESUME_RECORDING';
  chrome.runtime.sendMessage({ action }, (res) => {
    if (res && res.success) loadState();
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
function loadState() {
  chrome.runtime.sendMessage({ action: 'GET_STATE' }, (state) => {
    if (state) {
      updateUI({
        isRecording: state.isRecording || false,
        isPaused: state.isPaused || false,
        isReplaying: !!state.activeReplaySession,
        isReplayPaused: state.isReplayPaused || false,
        replaySpeed: state.replaySpeed || 1
      });
    }
  });
}

// Initial setup
loadState();
loadSessions();

// Periodic state updates
setInterval(loadState, 1000);

// Step control
if (stepBtn) {
  stepBtn.addEventListener('click', () => {
    chrome.runtime.sendMessage({ action: 'STEP_REPLAY' }, (res) => {
      if (!res || !res.success) {
        alert('Failed to send step command');
      }
    });
  });
}
