document.addEventListener('DOMContentLoaded', () => {
  const state = { me: null, token: null, ws: null, currentChat: null };
  const $ = (s) => document.querySelector(s);
  const $$ = (s) => document.querySelectorAll(s);

  const setView = (view) => {
    document.body.className = `view-${view}`;
    $('#logoutBtn').classList.toggle('hidden', view === 'auth');
  };

  const api = async (path, options = {}) => {
    const headers = { 'Content-Type': 'application/json', ...options.headers };
    if (state.token) headers.Authorization = `Bearer ${state.token}`;
    try {
      const response = await fetch(path, { ...options, headers });
      if (response.status === 401) { handleLogout(); return null; }
      return response;
    } catch (e) { return null; }
  };

  const handleLogout = async () => {
    if (state.token) await api('/api/logout', { method: 'POST' });
    localStorage.removeItem('token');
    localStorage.removeItem('me'); // This line is important
    if (state.ws) state.ws.close();
    Object.assign(state, { me: null, token: null, ws: null, currentChat: null });
    setView('auth');
    $('#chatList').innerHTML = '';
    $('#convActive').classList.add('hidden');
    $('#convPlaceholder').classList.remove('hidden');
  };

  const initializeApp = async () => {
    const res = await api('/api/users');
    if (!res) return;
    const users = await res.json();
    $('#chatList').innerHTML = users.map(user => `<li class="chat-item" data-username="${user.username}"><div class="avatar"><span>${user.username[0].toUpperCase()}</span><div class="dot ${user.online ? 'online' : ''}"></div></div><div class="item-main"><div class="item-name">${user.username}</div></div></li>`).join('');
    setupWebSocket();
  };

  const setupWebSocket = () => {
    if (state.ws) state.ws.close();
    state.ws = new WebSocket(`ws://${window.location.host}`);
    state.ws.onopen = () => state.ws.send(JSON.stringify({ type: 'auth', token: state.token }));
    state.ws.onmessage = (event) => {
      const msg = JSON.parse(event.data);
      if (msg.type === 'incoming_message' && state.currentChat === msg.from) {
        renderMessage(msg, 'you');
        markAsRead(msg.from);
      } else if (msg.type === 'read_receipt') {
        $$(`.tick[data-user="${msg.by}"]`).forEach(tick => tick.classList.add('read'));
      }
    };
  };

  const openConversation = async (username) => {
    state.currentChat = username;
    $('#convPlaceholder').classList.add('hidden');
    $('#convActive').classList.remove('hidden');
    $('#convHeader').innerHTML = `<div class="avatar"><span>${username[0].toUpperCase()}</span></div><div>${username}</div>`;
    const res = await api(`/api/history?with=${username}`);
    if (!res) return;
    $('#messages').innerHTML = '';
    const history = await res.json();
    history.forEach(msg => renderMessage(msg, msg.sender === state.me ? 'me' : 'you')); // The bug fix is here
    markAsRead(username);
  };
  
  const renderMessage = (msg, type) => {
    const el = document.createElement('div');
    el.className = `msg-row ${type}`;
    el.innerHTML = `<div class="bubble">${escapeHTML(msg.text)}<div class="meta-row"><span class="timestamp">${new Date(msg.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>${type === 'me' ? `<span class="tick ${msg.status === 'read' ? 'read' : ''}" data-user="${msg.receiver}"><i class="t1"></i><i class="t2"></i></span>` : ''}</div></div>`;
    $('#messages').appendChild(el);
    $('#messages').scrollTop = $('#messages').scrollHeight;
  };

  const markAsRead = (username) => {
    if (state.ws?.readyState === WebSocket.OPEN) state.ws.send(JSON.stringify({ type: 'mark_read', with: username }));
  };
  
  const escapeHTML = str => str.replace(/[&<>"']/g, m => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' })[m]);

  $('#loginForm').addEventListener('submit', async e => {
    e.preventDefault();
    const res = await api('/api/login', { method: 'POST', body: JSON.stringify({ username: $('#loginUsername').value, password: $('#loginPassword').value }) });
    if (res && res.ok) {
      const data = await res.json();
      state.token = data.token;
      state.me = data.username;
      localStorage.setItem('token', data.token);
      localStorage.setItem('me', data.username); // This line is important
      setView('chat');
      initializeApp();
    } else {
      $('#loginError').textContent = 'Invalid credentials';
    }
  });

  $('#registerForm').addEventListener('submit', async e => {
    e.preventDefault();
    const res = await api('/api/register', { method: 'POST', body: JSON.stringify({ username: $('#regUsername').value, password: $('#regPassword').value }) });
    if (res && res.ok) {
      $('#goLogin').click();
      $('#loginUsername').value = $('#regUsername').value;
      $('#loginError').textContent = 'Registration successful! Please log in.';
    } else {
      const data = res ? await res.json() : { error: 'Registration failed' };
      $('#registerError').textContent = data.error;
    }
  });
  
  $('#chatList').addEventListener('click', e => {
    const item = e.target.closest('.chat-item');
    if (item) {
        $$('.chat-item.active').forEach(el => el.classList.remove('active'));
        item.classList.add('active');
        openConversation(item.dataset.username);
    }
  });

  $('#composer').addEventListener('submit', e => {
    e.preventDefault();
    const input = $('#composerInput');
    if (input.value.trim() && state.currentChat) {
      const msg = { text: input.value, to: state.currentChat, clientId: Date.now().toString(), timestamp: Date.now() };
      state.ws.send(JSON.stringify({ type: 'send_message', ...msg }));
      renderMessage({ ...msg, sender: state.me, receiver: state.currentChat }, 'me');
      input.value = '';
    }
  });
  
  $('#goRegister').addEventListener('click', (e) => { e.preventDefault(); $('#registerForm').classList.remove('hidden'); $('#loginForm').classList.add('hidden'); $('#tabRegister').classList.add('active'); $('#tabLogin').classList.remove('active'); });
  $('#goLogin').addEventListener('click', (e) => { e.preventDefault(); $('#loginForm').classList.remove('hidden'); $('#registerForm').classList.add('hidden'); $('#tabLogin').classList.add('active'); $('#tabRegister').classList.remove('active'); });
  $('#logoutBtn').addEventListener('click', handleLogout);

  // This is the section that fixes the message alignment bug
  const token = localStorage.getItem('token');
  const me = localStorage.getItem('me');
  if (token && me) {
    state.token = token;
    state.me = me; // This line is crucial
    setView('chat');
    initializeApp();
  } else {
    setView('auth');
  }
});