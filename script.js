var DEFAULT_PREVIEW_MESSAGE = "Eg:You are the girl I will die for. If I were to rate you on a scale of 1 to 10, you would be an 11. - From Nuhu Tahiru";

function fetchJson(url, options) {
    return fetch(url, options).then(function(response) {
        return response.text().then(function(text) {
            var contentType = response.headers.get('content-type') || '';
            var looksLikeJson = contentType.indexOf('application/json') !== -1;
            var parsed = null;
            if (looksLikeJson) {
                try {
                    parsed = JSON.parse(text);
                } catch (e) {
                    parsed = null;
                }
            }

            if (!response.ok) {
                if (!looksLikeJson) {
                    throw new Error('Server error. Backend is not running. Response: ' + text.slice(0, 200));
                }
                if (parsed && (parsed.message || parsed.error)) {
                    throw new Error((parsed.message || parsed.error) + ' (HTTP ' + response.status + ')');
                }
                throw new Error('Server error: ' + response.status);
            }

            if (!looksLikeJson) {
                throw new Error('Backend is not running. The server returned HTML/text instead of JSON. Response: ' + text.slice(0, 200));
            }

            if (parsed) {
                return parsed;
            }
            try {
                return JSON.parse(text);
            } catch (e) {
                throw new Error('Invalid JSON from server. Response: ' + text.slice(0, 200));
            }
        });
    });
}

function setLoggedOutUI() {
    var loginBox = document.getElementById('loginBox');
    var smsBox = document.getElementById('smsBox');
    var logoutLink = document.getElementById('logoutLink');
    var fixedBrand = document.getElementById('fixedBrand');
    var brandHeader = document.getElementById('brandHeader');
    var previewSender = document.getElementById('previewSender');
    var adminBox = document.getElementById('adminBox');

    if (loginBox) loginBox.style.display = '';
    if (smsBox) smsBox.style.display = 'none';
    if (logoutLink) logoutLink.style.display = 'none';
    if (fixedBrand) fixedBrand.value = '';
    if (brandHeader) brandHeader.textContent = 'Inbox';
    if (previewSender) previewSender.textContent = 'Sender';

    var statusBox = document.getElementById('statusBox');
    if (statusBox) statusBox.innerHTML = '';

    if (adminBox) adminBox.style.display = 'none';
}

function setLoggedInUI(brandname, isAdmin) {
    var loginBox = document.getElementById('loginBox');
    var smsBox = document.getElementById('smsBox');
    var logoutLink = document.getElementById('logoutLink');
    var fixedBrand = document.getElementById('fixedBrand');
    var brandHeader = document.getElementById('brandHeader');
    var senderElements = document.querySelectorAll('.sender');
    var adminBox = document.getElementById('adminBox');

    if (loginBox) loginBox.style.display = 'none';
    if (smsBox) smsBox.style.display = '';
    if (logoutLink) logoutLink.style.display = '';
    if (fixedBrand) fixedBrand.value = brandname || '';
    if (brandHeader) brandHeader.textContent = brandname ? (brandname + ' Inbox') : 'Inbox';
    senderElements.forEach(function(el) { el.textContent = brandname || 'Sender'; });

    var statusBox = document.getElementById('statusBox');
    if (statusBox) statusBox.innerHTML = '';

    if (adminBox) {
        adminBox.style.display = isAdmin ? '' : 'none';
        if (isAdmin) {
            refreshUsers();
        }
    }
}

function renderStatus(type, title, metaText) {
    var statusBox = document.getElementById('statusBox');
    if (!statusBox) return;

    var safeTitle = String(title || '');
    var safeMeta = String(metaText || '');

    statusBox.innerHTML =
        '<div class="status-card ' + (type === 'success' ? 'success' : 'error') + '">' +
            '<div class="status-title">' + escapeHtml(safeTitle) + '</div>' +
            '<div class="status-meta">' + escapeHtml(safeMeta) + '</div>' +
        '</div>';
}

function renderStatusInto(el, type, title, metaText) {
    if (!el) return;
    var safeTitle = String(title || '');
    var safeMeta = String(metaText || '');
    el.innerHTML =
        '<div class="status-card ' + (type === 'success' ? 'success' : 'error') + '">' +
            '<div class="status-title">' + escapeHtml(safeTitle) + '</div>' +
            '<div class="status-meta">' + escapeHtml(safeMeta) + '</div>' +
        '</div>';
}

function escapeHtml(str) {
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}

function fetchSession() {
    return fetchJson('/api/session', { method: 'GET' })
        .then(function(data) {
            if (data.status !== 'success') {
                setLoggedOutUI();
                return null;
            }
            if (data.logged_in) {
                setLoggedInUI(data.brandname, data.is_admin);
                return data;
            }
            setLoggedOutUI();
            return null;
        })
        .catch(function() {
            setLoggedOutUI();
            return null;
        });
}

function applyModeFromUrl() {
    var params = new URLSearchParams(window.location.search || '');
    var mode = (params.get('mode') || '').toLowerCase();

    var loginBox = document.getElementById('loginBox');
    var smsBox = document.getElementById('smsBox');
    var freeBox = document.getElementById('freeBox');
    var brandHeader = document.getElementById('brandHeader');

    if (mode === 'free') {
        if (loginBox) loginBox.style.display = 'none';
        if (smsBox) smsBox.style.display = 'none';
        if (freeBox) freeBox.style.display = '';
        if (brandHeader) brandHeader.textContent = 'FREE';
        return true;
    }

    if (freeBox) freeBox.style.display = 'none';
    return false;
}

function login() {
    var username = (document.getElementById('loginUsername') || {}).value || '';
    var password = (document.getElementById('loginPassword') || {}).value || '';

    username = username.trim();
    if (!username || !password) {
        alert('Enter username and password');
        return;
    }

    fetchJson('/api/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: username, password: password })
    })
        .then(function(res) {
            if (res.status === 'success' && res.logged_in) {
                setLoggedInUI(res.brandname, res.is_admin);
                var passwordEl = document.getElementById('loginPassword');
                if (passwordEl) passwordEl.value = '';
                applyTemplateToMessageIfAny();
                return;
            }
            alert(res.message || 'Login failed');
        })
        .catch(function(err) {
            alert(err && err.message ? err.message : 'Login failed');
        });
}

function logout() {
    fetchJson('/api/logout', { method: 'POST' })
        .then(function() {
            setLoggedOutUI();
        })
        .catch(function() {
            setLoggedOutUI();
        });
}

function updatePreviewMessage() {
    var messageInput = document.getElementById('Message1');
    if (!messageInput) return;
    var messageText = messageInput.value;
    var messageElements = document.querySelectorAll('.message p');
    messageElements.forEach(function(element) {
        element.textContent = messageText || DEFAULT_PREVIEW_MESSAGE;
    });
}

function autoGrowTextarea(el) {
    if (!el) return;
    var maxHeight = Number(el.getAttribute('data-max-height') || '200');
    el.style.height = 'auto';
    var nextHeight = el.scrollHeight;
    if (nextHeight > maxHeight) {
        el.style.height = maxHeight + 'px';
        el.style.overflowY = 'auto';
        return;
    }
    el.style.height = nextHeight + 'px';
    el.style.overflowY = 'hidden';
}

function applyTemplateToMessageIfAny() {
    var templateText = localStorage.getItem('templateText');
    if (!templateText) return;
    var messageInput = document.getElementById('Message1');
    if (messageInput) {
        messageInput.value = templateText;
        updatePreviewMessage();
        autoGrowTextarea(messageInput);
    }
    localStorage.removeItem('templateText');
}

function useTemplate(templateText) {
    localStorage.setItem('templateText', templateText);
    window.location.href = 'index.html';
}

function refreshUsers() {
    var usersList = document.getElementById('usersList');
    if (!usersList) return;
    usersList.textContent = 'Loading...';

    fetchJson('/api/admin/users', { method: 'GET' })
        .then(function(res) {
            if (res.status !== 'success' || !Array.isArray(res.users)) {
                usersList.textContent = 'Failed to load users';
                return;
            }
            if (res.users.length === 0) {
                usersList.textContent = 'No users yet';
                return;
            }
            usersList.innerHTML = res.users.map(function(u) {
                var line1 = (u.username || '') + (u.is_admin ? ' (admin)' : '');
                var line2 = 'Brandname: ' + (u.brandname || '') + (u.disabled ? ' • Disabled' : ' • Active');
                var actions = '';
                if (!u.is_admin) {
                    actions =
                        '<div class="user-actions">' +
                            '<button class="mini-button js-toggle-user" data-username="' + escapeHtml(u.username || '') + '" data-disabled="' + (u.disabled ? '0' : '1') + '">' + (u.disabled ? 'Enable' : 'Disable') + '</button>' +
                            '<button class="mini-button js-reset-pass" data-username="' + escapeHtml(u.username || '') + '">Reset Password</button>' +
                        '</div>';
                }
                return '<div class="user-row"><div class="u1">' + escapeHtml(line1) + '</div><div class="u2">' + escapeHtml(line2) + '</div>' + actions + '</div>';
            }).join('');
        })
        .catch(function(err) {
            usersList.textContent = err && err.message ? err.message : 'Failed to load users';
        });
}

function createUser() {
    var btn = document.getElementById('createUserBtn');
    var usernameEl = document.getElementById('newUsername');
    var brandEl = document.getElementById('newBrandname');
    var passwordEl = document.getElementById('newPassword');

    var username = usernameEl ? usernameEl.value.trim() : '';
    var brandname = brandEl ? brandEl.value.trim() : '';
    var password = passwordEl ? passwordEl.value : '';

    if (!username || !brandname || !password) {
        renderStatus('error', 'Fill all fields', 'Username, brandname and password are required.');
        return;
    }

    if (btn) {
        btn.disabled = true;
        btn.textContent = 'Creating...';
    }

    fetchJson('/api/admin/users', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: username, brandname: brandname, password: password })
    })
        .then(function(res) {
            if (btn) {
                btn.disabled = false;
                btn.textContent = 'Create Account';
            }
            if (res.status === 'success') {
                if (usernameEl) usernameEl.value = '';
                if (brandEl) brandEl.value = '';
                if (passwordEl) passwordEl.value = '';
                renderStatus('success', 'Account created', 'Username: ' + username + '\nBrandname: ' + brandname);
                refreshUsers();
                return;
            }
            renderStatus('error', 'Failed', res.message || 'Could not create account');
        })
        .catch(function(err) {
            if (btn) {
                btn.disabled = false;
                btn.textContent = 'Create Account';
            }
            renderStatus('error', 'Error', err && err.message ? err.message : 'Could not create account');
        });
}

function sendFreeSMS() {
    var messageEl = document.getElementById('freeMessage');
    var phoneEl = document.getElementById('freeRecipientPhone');
    var senderEl = document.getElementById('freeSender');
    var sendBtn = document.getElementById('freeSendBtn');
    var statusEl = document.getElementById('freeStatusBox');

    var message = messageEl ? messageEl.value.trim() : '';
    var recipientPhone = phoneEl ? phoneEl.value.trim() : '';
    var senderId = senderEl ? senderEl.value : '';

    if (!senderId || !message || !recipientPhone) {
        renderStatusInto(statusEl, 'error', 'Fill all fields', 'Choose Sender ID, enter message and phone number.');
        return;
    }

    if (sendBtn) {
        sendBtn.disabled = true;
        sendBtn.textContent = 'Sending...';
    }
    renderStatusInto(statusEl, 'success', 'Sending...', 'Please wait.');

    fetchJson('/api/send-sms-free', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ senderId: senderId, message: message, recipientPhone: recipientPhone })
    })
        .then(function(res) {
            if (sendBtn) {
                sendBtn.disabled = false;
                sendBtn.textContent = 'Send FREE';
            }
            if (res.status === 'success') {
                var meta = 'From: ' + senderId + '\nTo: ' + recipientPhone + '\nMessage: ' + message;
                renderStatusInto(statusEl, 'success', 'SMS sent successfully', meta);
                return;
            }
            renderStatusInto(statusEl, 'error', 'Failed to send SMS', res.message || 'Unknown error');
        })
        .catch(function(err) {
            if (sendBtn) {
                sendBtn.disabled = false;
                sendBtn.textContent = 'Send FREE';
            }
            renderStatusInto(statusEl, 'error', 'Error', err && err.message ? err.message : 'An error occurred.');
        });
}

function sendSMS() {
    var messageEl = document.getElementById('Message1');
    var phoneEl = document.getElementById('recipientPhone');
    var sendBtn = document.getElementById('sendBtn');

    var message = messageEl ? messageEl.value.trim() : '';
    var recipientPhone = phoneEl ? phoneEl.value.trim() : '';

    if (!message || !recipientPhone) {
        renderStatus('error', 'Fill all fields', 'Enter message and customer phone number.');
        return;
    }

    if (sendBtn) {
        sendBtn.disabled = true;
        sendBtn.textContent = 'Sending...';
    }
    renderStatus('success', 'Sending...', 'Please wait.');

    fetchJson('/api/send-sms', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: message, recipientPhone: recipientPhone })
    })
    .then(function(res) {
        if (sendBtn) {
            sendBtn.disabled = false;
            sendBtn.textContent = 'Send';
        }
        if (res.status === 'success') {
            var brand = (document.getElementById('fixedBrand') || {}).value || 'Sender';
            var meta = 'From: ' + brand + '\nTo: ' + recipientPhone + '\nMessage: ' + message;
            if (Object.prototype.hasOwnProperty.call(res, 'template_saved')) {
                if (res.template_saved) {
                    meta += '\nTemplate: saved';
                } else {
                    meta += '\nTemplate: already exists';
                }
            }
            renderStatus('success', 'SMS sent successfully', meta);
        } else if (res.message === 'Not logged in') {
            renderStatus('error', 'Session expired', 'Please login again.');
            setLoggedOutUI();
        } else {
            var meta = (res.message || 'Unknown error') + (res.raw_response ? '\n' + res.raw_response : '');
            renderStatus('error', 'Failed to send SMS', meta);
        }
    })
    .catch(function(err) {
        if (sendBtn) {
            sendBtn.disabled = false;
            sendBtn.textContent = 'Send';
        }
        renderStatus('error', 'Error', err && err.message ? err.message : 'An error occurred while sending the SMS.');
    });
}

function setTemplateStatus(text) {
    var el = document.getElementById('templateStatus');
    if (!el) return;
    el.textContent = String(text || '');
}

function renderTemplates(templates) {
    var list = document.getElementById('dynamicTemplates');
    if (!list) return;
    if (!Array.isArray(templates) || templates.length === 0) {
        list.innerHTML = '<div class="template-empty">No templates yet. Send an SMS and it will be saved here.</div>';
        return;
    }
    list.innerHTML = templates.map(function(t) {
        var id = t.id || '';
        var text = t.text || '';
        var title = text.split('\n')[0] || text;
        if (title.length > 18) title = title.slice(0, 18) + '...';
        return (
            '<div class="flip-box">' +
                '<div class="flip-box-inner">' +
                    '<div class="flip-box-front">' +
                        '<h2>' + escapeHtml(title || 'Template') + '</h2>' +
                    '</div>' +
                    '<div class="flip-box-back">' +
                        '<h4>' + escapeHtml(text) + '</h4>' +
                        '<button class="use-template-button js-use-template" data-text="' + escapeHtml(text) + '">Use Template</button>' +
                        '<button class="delete-template-button js-delete-template" data-id="' + escapeHtml(id) + '">Delete</button>' +
                    '</div>' +
                '</div>' +
            '</div>'
        );
    }).join('');
}

function loadTemplates() {
    setTemplateStatus('Loading...');
    return fetchJson('/api/templates', { method: 'GET' })
        .then(function(res) {
            if (res.status !== 'success') {
                setTemplateStatus('Failed to load templates');
                return;
            }
            setTemplateStatus('');
            renderTemplates(res.templates || []);
        })
        .catch(function(err) {
            setTemplateStatus(err && err.message ? err.message : 'Failed to load templates');
        });
}

function deleteTemplate(templateId) {
    if (!templateId) return;
    fetchJson('/api/templates/delete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: templateId })
    })
        .then(function(res) {
            if (res.status === 'success') {
                setTemplateStatus('Deleted');
                loadTemplates();
                return;
            }
            setTemplateStatus(res.message || 'Failed to delete');
        })
        .catch(function(err) {
            setTemplateStatus(err && err.message ? err.message : 'Failed to delete');
        });
}

document.addEventListener('DOMContentLoaded', function() {
    var isFreeMode = applyModeFromUrl();

    if (isFreeMode) {
        var freeMessage = document.getElementById('freeMessage');
        var freePhone = document.getElementById('freeRecipientPhone');
        if (freeMessage) {
            freeMessage.addEventListener('input', function() { autoGrowTextarea(freeMessage); });
            autoGrowTextarea(freeMessage);
        }
        if (freePhone) {
            freePhone.addEventListener('input', function() { autoGrowTextarea(freePhone); });
            autoGrowTextarea(freePhone);
        }
        return;
    }

    var messageInput = document.getElementById('Message1');
    if (messageInput) {
        messageInput.addEventListener('input', updatePreviewMessage);
        messageInput.addEventListener('input', function() { autoGrowTextarea(messageInput); });
    }

    var recipientInput = document.getElementById('recipientPhone');
    if (recipientInput) {
        recipientInput.addEventListener('input', function() { autoGrowTextarea(recipientInput); });
    }

    fetchSession().then(function(session) {
        var templatesList = document.getElementById('dynamicTemplates');
        if (templatesList) {
            if (!session || !session.logged_in) {
                window.location.href = 'index.html';
                return;
            }
            loadTemplates();
            templatesList.addEventListener('click', function(e) {
                var t = e.target;
                if (!t) return;
                if (t.classList && t.classList.contains('js-use-template')) {
                    var txt = t.getAttribute('data-text') || '';
                    useTemplate(txt);
                    return;
                }
                if (t.classList && t.classList.contains('js-delete-template')) {
                    var id = t.getAttribute('data-id') || '';
                    deleteTemplate(id);
                    return;
                }
            });
            return;
        }

        if (session && session.logged_in) {
            applyTemplateToMessageIfAny();
        }
    });

    var usersList = document.getElementById('usersList');
    if (usersList) {
        usersList.addEventListener('click', function(e) {
            var t = e.target;
            if (!t) return;
            if (t.classList && t.classList.contains('js-toggle-user')) {
                var username = t.getAttribute('data-username') || '';
                var disabled = t.getAttribute('data-disabled') === '1';
                toggleUserDisabled(username, disabled);
                return;
            }
            if (t.classList && t.classList.contains('js-reset-pass')) {
                var username2 = t.getAttribute('data-username') || '';
                resetUserPassword(username2);
                return;
            }
        });
    }

    updatePreviewMessage();
    autoGrowTextarea(messageInput);
    autoGrowTextarea(recipientInput);
});

function toggleUserDisabled(username, disabled) {
    if (!username) return;
    fetchJson('/api/admin/users/disable', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: username, disabled: disabled })
    })
        .then(function(res) {
            if (res.status === 'success') {
                renderStatus('success', 'Updated', username + (disabled ? ' disabled' : ' enabled'));
                refreshUsers();
                return;
            }
            renderStatus('error', 'Failed', res.message || 'Could not update user');
        })
        .catch(function(err) {
            renderStatus('error', 'Error', err && err.message ? err.message : 'Could not update user');
        });
}

function resetUserPassword(username) {
    if (!username) return;
    var newPass = window.prompt('Enter new password for ' + username);
    if (!newPass) return;
    fetchJson('/api/admin/users/reset-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: username, new_password: newPass })
    })
        .then(function(res) {
            if (res.status === 'success') {
                renderStatus('success', 'Password reset', 'Password changed for ' + username);
                return;
            }
            renderStatus('error', 'Failed', res.message || 'Could not reset password');
        })
        .catch(function(err) {
            renderStatus('error', 'Error', err && err.message ? err.message : 'Could not reset password');
        });
}


