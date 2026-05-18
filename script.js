var DEFAULT_PREVIEW_MESSAGE = "You are the girl I will die for. If I were to rate you on a scale of 1 to 10, you would be 11. - From Nuhu Tahiru";
var CURRENT_SESSION = null;
var PRICE_CURRENCY_LABEL = '₵';
var PAYSTACK_FIXED_EMAIL = 'nuhuibntahir@gmail.com';
var SUBSCRIPTION_PLANS = [
    { sms: 25, price: 1 },
    { sms: 50, price: 3 },
    { sms: 100, price: 7 },
    { sms: 250, price: 15 },
    { sms: 500, price: 30 },
    { sms: 700, price: 60 }
];
var SELECTED_SUBSCRIPTION_SMS = null;
var HOME_ADS = [];
var SPECIAL_ADS = [];
var HOME_PREVIEW_MESSAGE = '';
var SPECIAL_PREVIEW_MESSAGE = '';
var TRUSTED_BRANDS = [];
var _adminStatsDays = 30;
var _adminAdsTicker = { timeout: null, index: 0, charIndex: 0, list: [], speed: 32, pauseMs: 30000, betweenMs: 220 };

function escapeHtml(str) {
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}

function renderSmsBalanceBadge(session) {
    var badge = document.getElementById('smsBalanceBadge');
    if (!badge) return;
    if (!session || !session.logged_in) {
        badge.style.display = 'none';
        badge.textContent = '';
        return;
    }
    var txt = (session.is_admin || session.is_free) ? 'SMS: ∞' : ('SMS: ' + String(session.sms_credits || 0));
    badge.textContent = txt;
    badge.style.display = '';
}

function setAdminAdsBanner(mode, posts) {
    var banner = document.getElementById('adminAdsBanner');
    var kicker = document.getElementById('adminAdsKicker');
    var typing = document.getElementById('adminAdsTyping');
    if (!banner || !kicker || !typing) return;
    var list = Array.isArray(posts) ? posts.filter(Boolean) : [];
    if (!list.length) {
        banner.style.display = 'none';
        typing.textContent = '';
        return;
    }
    banner.style.display = '';
    kicker.textContent = (mode === 'special') ? 'Texting' : 'Business Ideas';
    startAdminAdsTicker(list);
}

function stopAdminAdsTicker() {
    try { if (_adminAdsTicker.timeout) clearTimeout(_adminAdsTicker.timeout); } catch (e) {}
    _adminAdsTicker.timeout = null;
    _adminAdsTicker.index = 0;
    _adminAdsTicker.charIndex = 0;
    _adminAdsTicker.list = [];
    var typing = document.getElementById('adminAdsTyping');
    if (typing) typing.textContent = '';
}

function startAdminAdsTicker(list) {
    stopAdminAdsTicker();
    var typing = document.getElementById('adminAdsTyping');
    if (!typing) return;
    _adminAdsTicker.list = list.slice(0);
    _adminAdsTicker.index = 0;
    _adminAdsTicker.charIndex = 0;
    (function step() {
        if (!_adminAdsTicker.list.length) return;
        var full = String(_adminAdsTicker.list[_adminAdsTicker.index] || '');
        if (!full) {
            _adminAdsTicker.index = (_adminAdsTicker.index + 1) % _adminAdsTicker.list.length;
            _adminAdsTicker.timeout = setTimeout(step, _adminAdsTicker.betweenMs);
            return;
        }

        _adminAdsTicker.charIndex = Math.min(full.length, _adminAdsTicker.charIndex + 1);
        typing.textContent = full.slice(0, _adminAdsTicker.charIndex);
        if (_adminAdsTicker.charIndex >= full.length) {
            _adminAdsTicker.timeout = setTimeout(function() {
                _adminAdsTicker.index = (_adminAdsTicker.index + 1) % _adminAdsTicker.list.length;
                _adminAdsTicker.charIndex = 0;
                typing.textContent = '';
                step();
            }, _adminAdsTicker.pauseMs);
            return;
        }
        _adminAdsTicker.timeout = setTimeout(step, _adminAdsTicker.speed);
    })();
}

function loadAds() {
    return fetchJson('/api/ads', { method: 'GET' })
        .then(function(res) {
            if (res && res.status === 'success') {
                HOME_ADS = Array.isArray(res.home_ads) ? res.home_ads : [];
                SPECIAL_ADS = Array.isArray(res.special_ads) ? res.special_ads : [];
                HOME_PREVIEW_MESSAGE = typeof res.home_preview_message === 'string' ? res.home_preview_message : '';
                SPECIAL_PREVIEW_MESSAGE = typeof res.special_preview_message === 'string' ? res.special_preview_message : '';
            }
            return { home: HOME_ADS, special: SPECIAL_ADS };
        })
        .catch(function() {
            return { home: HOME_ADS, special: SPECIAL_ADS };
        });
}

function loadTrustedBrands() {
    return fetchJson('/api/public/trusted-brands', { method: 'GET' })
        .then(function(res) {
            if (res && res.status === 'success') {
                TRUSTED_BRANDS = Array.isArray(res.brands) ? res.brands : [];
            }
            return TRUSTED_BRANDS;
        })
        .catch(function() {
            return TRUSTED_BRANDS;
        });
}

function parseTrustedBrandsText(text) {
    var raw = String(text || '');
    var lines = raw.split('\n');
    var out = [];
    var seen = {};
    lines.forEach(function(line) {
        var t = String(line || '').trim();
        if (!t) return;
        var name = '';
        var logo = '';
        if (t.indexOf('||') !== -1) {
            var parts = t.split('||');
            name = String(parts[0] || '').trim();
            logo = String(parts.slice(1).join('||') || '').trim();
        } else if (t.indexOf('|') !== -1) {
            var parts2 = t.split('|');
            name = String(parts2[0] || '').trim();
            logo = String(parts2.slice(1).join('|') || '').trim();
        } else if (t.indexOf('~~') !== -1) {
            var parts3 = t.split('~~');
            name = String(parts3[0] || '').trim();
            logo = String(parts3.slice(1).join('~~') || '').trim();
        } else if (t.indexOf('~') !== -1) {
            var parts4 = t.split('~');
            name = String(parts4[0] || '').trim();
            logo = String(parts4.slice(1).join('~') || '').trim();
        } else {
            name = t;
        }
        name = name.replace(/\s+/g, ' ').trim();
        if (!name) return;
        var k = name.toLowerCase();
        if (seen[k]) return;
        seen[k] = true;
        out.push({ name: name, logo: logo });
    });
    return out;
}

function trustedBrandsToText(brands) {
    var list = Array.isArray(brands) ? brands : [];
    return list.map(function(b) {
        if (!b) return '';
        var name = String(b.name || '').trim();
        var logo = String(b.logo || '').trim();
        if (!name) return '';
        if (logo) return name + ' || ' + logo;
        return name;
    }).filter(Boolean).join('\n');
}

function saveTrustedBrands() {
    var ta = document.getElementById('adminTrustedBrandsText');
    var btn = document.getElementById('saveTrustedBrandsBtn');
    var statusEl = document.getElementById('adminTrustedBrandsStatus');
    var items = parseTrustedBrandsText(ta ? ta.value : '');
    if (btn) { btn.disabled = true; btn.textContent = 'Saving...'; }
    renderStatusInto(statusEl, 'success', 'Trusted Brands', 'Saving...');
    fetchJson('/api/admin/trusted-brands', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ brands: items }) })
        .then(function(res) {
            if (res.status !== 'success') {
                renderStatusInto(statusEl, 'error', 'Trusted Brands', res.message || 'Failed to save.');
                return;
            }
            TRUSTED_BRANDS = Array.isArray(res.brands) ? res.brands : TRUSTED_BRANDS;
            if (ta) { ta.value = trustedBrandsToText(TRUSTED_BRANDS); autoGrowTextarea(ta); }
            renderStatusInto(statusEl, 'success', 'Trusted Brands', 'Saved.');
        })
        .catch(function(err) {
            renderStatusInto(statusEl, 'error', 'Trusted Brands', err && err.message ? err.message : 'Failed to save.');
        })
        .finally(function() {
            if (btn) { btn.disabled = false; btn.textContent = 'Save Trusted Brands'; }
        });
}

function clearTrustedBrands() {
    var ta = document.getElementById('adminTrustedBrandsText');
    var btn = document.getElementById('clearTrustedBrandsBtn');
    var saveBtn = document.getElementById('saveTrustedBrandsBtn');
    var statusEl = document.getElementById('adminTrustedBrandsStatus');
    if (btn) { btn.disabled = true; btn.textContent = 'Clearing...'; }
    if (saveBtn) saveBtn.disabled = true;
    renderStatusInto(statusEl, 'success', 'Trusted Brands', 'Clearing...');
    fetchJson('/api/admin/trusted-brands', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ brands: [] }) })
        .then(function(res) {
            if (res.status !== 'success') {
                renderStatusInto(statusEl, 'error', 'Trusted Brands', res.message || 'Failed to clear.');
                return;
            }
            TRUSTED_BRANDS = [];
            if (ta) { ta.value = ''; autoGrowTextarea(ta); }
            renderStatusInto(statusEl, 'success', 'Trusted Brands', 'Cleared.');
        })
        .catch(function(err) {
            renderStatusInto(statusEl, 'error', 'Trusted Brands', err && err.message ? err.message : 'Failed to clear.');
        })
        .finally(function() {
            if (btn) { btn.disabled = false; btn.textContent = 'Clear'; }
            if (saveBtn) saveBtn.disabled = false;
        });
}

function computeAdminStats(logs, usersRes, days) {
    var d = Number(days || 0);
    if (!isFinite(d)) d = 0;
    d = Math.max(0, Math.min(365, Math.floor(d)));
    var cutoff = null;
    if (d > 0) cutoff = Date.now() - (d * 86400000);

    var usersMap = {};
    if (usersRes && usersRes.status === 'success' && Array.isArray(usersRes.users)) {
        usersRes.users.forEach(function(u) {
            if (!u || !u.username) return;
            usersMap[String(u.username)] = u;
        });
    }

    var totals = {};
    var totalEvents = 0;
    var totalRecipients = 0;
    (Array.isArray(logs) ? logs : []).forEach(function(entry) {
        if (!entry || !entry.username) return;
        var ts = String(entry.ts || '');
        if (cutoff !== null) {
            var dt = Date.parse(ts);
            if (!isFinite(dt)) return;
            if (dt < cutoff) return;
        }
        var username = String(entry.username || '').trim();
        if (!username) return;
        var toList = entry.to;
        var rc = Array.isArray(toList) ? toList.filter(Boolean).length : 1;
        var brand = String(entry.brandname || '').trim();
        totalEvents += 1;
        totalRecipients += rc;
        var cur = totals[username] || { username: username, total_sends: 0, total_recipients: 0, last_sent: '', brandname: '' };
        cur.total_sends += 1;
        cur.total_recipients += rc;
        if (brand && !cur.brandname) cur.brandname = brand;
        if (ts && (!cur.last_sent || ts > cur.last_sent)) cur.last_sent = ts;
        totals[username] = cur;
    });

    var list = Object.keys(totals).map(function(username) {
        var agg = totals[username] || {};
        var u = usersMap[username] || {};
        return {
            username: username,
            name: String(u.name || ''),
            brandname: String(u.brandname || agg.brandname || ''),
            is_admin: !!u.is_admin,
            total_sends: Number(agg.total_sends || 0),
            total_recipients: Number(agg.total_recipients || 0),
            last_sent: String(agg.last_sent || '')
        };
    });
    list.sort(function(a, b) {
        if (b.total_recipients !== a.total_recipients) return b.total_recipients - a.total_recipients;
        if (b.total_sends !== a.total_sends) return b.total_sends - a.total_sends;
        return String(a.username).localeCompare(String(b.username));
    });
    return {
        status: 'success',
        days: d,
        total_events: totalEvents,
        total_recipients: totalRecipients,
        count_users: list.length,
        top_users: list.slice(0, 20)
    };
}

function renderAdminStats(res, metaText) {
    var chart = document.getElementById('adminStatsChart');
    var statusEl = document.getElementById('adminStatsStatus');
    if (!chart) return;
    if (!res || res.status !== 'success') {
        if (statusEl) renderStatusInto(statusEl, 'error', 'Dashboard', (res && res.message) ? res.message : 'Failed to load stats.');
        chart.innerHTML = '';
        return;
    }
    var list = Array.isArray(res.top_users) ? res.top_users : [];
    var max = 0;
    list.forEach(function(u) {
        max = Math.max(max, Number(u.total_recipients || 0));
    });
    if (!list.length) {
        if (statusEl) renderStatusInto(statusEl, 'success', 'Dashboard', 'No messages sent yet.');
        chart.innerHTML = '';
        return;
    }
    if (statusEl) {
        var meta = 'Users: ' + String(res.count_users || list.length) + '\nMessages: ' + String(res.total_events || 0) + '\nRecipients: ' + String(res.total_recipients || 0);
        if (metaText) meta = meta + '\n' + String(metaText);
        renderStatusInto(statusEl, 'success', 'Dashboard', meta);
    }
    chart.innerHTML = '<div class="chart-wrap">' + list.map(function(u) {
        var name = String(u.brandname || u.username || '').trim() || String(u.username || '');
        var recipients = Number(u.total_recipients || 0);
        var sends = Number(u.total_sends || 0);
        var pct = max > 0 ? Math.max(2, Math.round((recipients / max) * 100)) : 0;
        return (
            '<div class="chart-row">' +
                '<div class="chart-left">' +
                    '<div class="chart-name">' + escapeHtml(name) + '</div>' +
                    '<div class="chart-sub">' + escapeHtml(String(u.username || '')) + '</div>' +
                '</div>' +
                '<div class="chart-mid"><div class="chart-bar" style="width:' + String(pct) + '%"></div></div>' +
                '<div class="chart-right">' + escapeHtml(String(recipients)) + '<span class="chart-unit"> to</span><div class="chart-mini">' + escapeHtml(String(sends)) + ' msgs</div></div>' +
            '</div>'
        );
    }).join('') + '</div>';
}

function refreshAdminDashboard(days) {
    _adminStatsDays = Number(days || 0);
    var statusEl = document.getElementById('adminStatsStatus');
    if (statusEl) renderStatusInto(statusEl, 'success', 'Dashboard', 'Loading...');
    return Promise.all([
        fetchJson('/api/admin/sms-logs?limit=200', { method: 'GET' }),
        fetchJson('/api/admin/users', { method: 'GET' })
    ])
        .then(function(pair) {
            var logsRes = pair[0];
            var usersRes = pair[1];
            if (!logsRes || logsRes.status !== 'success' || !Array.isArray(logsRes.logs)) {
                renderAdminStats({ status: 'error', message: (logsRes && logsRes.message) ? logsRes.message : 'Failed to load logs.' });
                return;
            }
            var stats = computeAdminStats(logsRes.logs, usersRes, _adminStatsDays);
            var meta = 'Based on last ' + String(Math.min(200, logsRes.logs.length)) + ' sends';
            renderAdminStats(stats, meta);
        })
        .catch(function(err) {
            var chart = document.getElementById('adminStatsChart');
            if (statusEl) renderStatusInto(statusEl, 'error', 'Dashboard', err && err.message ? err.message : 'Failed to load stats.');
            if (chart) chart.innerHTML = '';
        });
}

function adminChangePassword() {
    var cur = document.getElementById('adminCurrentPassword');
    var n1 = document.getElementById('adminNewPassword');
    var n2 = document.getElementById('adminNewPassword2');
    var btn = document.getElementById('adminChangePasswordBtn');
    var statusEl = document.getElementById('adminChangePasswordStatus');
    var currentPassword = cur ? String(cur.value || '') : '';
    var newPassword = n1 ? String(n1.value || '') : '';
    var confirmPassword = n2 ? String(n2.value || '') : '';
    if (!newPassword || !confirmPassword) {
        renderStatusInto(statusEl, 'error', 'Password', 'Fill all fields.');
        return;
    }
    if (newPassword !== confirmPassword) {
        renderStatusInto(statusEl, 'error', 'Password', 'New passwords do not match.');
        return;
    }
    if (newPassword.length < 6) {
        renderStatusInto(statusEl, 'error', 'Password', 'Password must be at least 6 characters.');
        return;
    }
    if (btn) { btn.disabled = true; btn.textContent = 'Updating...'; }
    renderStatusInto(statusEl, 'success', 'Password', 'Updating...');
    var username = CURRENT_SESSION && CURRENT_SESSION.username ? String(CURRENT_SESSION.username) : '';
    fetchJson('/api/admin/users/reset-password', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: username, new_password: newPassword }) })
        .then(function(res) {
            if (res.status !== 'success') {
                renderStatusInto(statusEl, 'error', 'Password', res.message || 'Failed to update.');
                return;
            }
            if (cur) cur.value = '';
            if (n1) n1.value = '';
            if (n2) n2.value = '';
            renderStatusInto(statusEl, 'success', 'Password', 'Updated.');
        })
        .catch(function(err) {
            renderStatusInto(statusEl, 'error', 'Password', err && err.message ? err.message : 'Failed to update.');
        })
        .finally(function() {
            if (btn) { btn.disabled = false; btn.textContent = 'Update Password'; }
        });
}

function applyAdsForMode(mode) {
    var m = String(mode || '').toLowerCase();
    if (m === 'special') {
        setAdminAdsBanner('special', SPECIAL_ADS);
        return;
    }
    if (m === '' || m === 'home') {
        setAdminAdsBanner('home', HOME_ADS);
        return;
    }
    stopAdminAdsTicker();
    var banner = document.getElementById('adminAdsBanner');
    if (banner) banner.style.display = 'none';
}

function saveHomeAds() {
    var ta = document.getElementById('adminHomeAdsText');
    var btn = document.getElementById('saveHomeAdsBtn');
    var statusEl = document.getElementById('adminHomeAdsStatus');
    var text = ta ? String(ta.value || '') : '';
    var previewTa = document.getElementById('adminHomePreviewText');
    var previewMessage = previewTa ? String(previewTa.value || '') : '';
    if (btn) { btn.disabled = true; btn.textContent = 'Saving...'; }
    renderStatusInto(statusEl, 'success', 'Business Ideas', 'Saving...');
    fetchJson('/api/admin/ads/home', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: text, preview_message: previewMessage }) })
        .then(function(res) {
            if (res.status !== 'success') {
                renderStatusInto(statusEl, 'error', 'Business Ideas', res.message || 'Failed to save.');
                return;
            }
            HOME_ADS = Array.isArray(res.home_ads) ? res.home_ads : [];
            HOME_PREVIEW_MESSAGE = typeof res.home_preview_message === 'string' ? res.home_preview_message : HOME_PREVIEW_MESSAGE;
            renderStatusInto(statusEl, 'success', 'Business Ideas', 'Saved.');
            applyAdsForMode(currentMode());
            updatePreviewMessage();
        })
        .catch(function(err) {
            renderStatusInto(statusEl, 'error', 'Business Ideas', err && err.message ? err.message : 'Failed to save.');
        })
        .finally(function() {
            if (btn) { btn.disabled = false; btn.textContent = 'Save Business Ideas'; }
        });
}

function saveSpecialAds() {
    var ta = document.getElementById('adminSpecialAdsText');
    var btn = document.getElementById('saveSpecialAdsBtn');
    var statusEl = document.getElementById('adminSpecialAdsStatus');
    var text = ta ? String(ta.value || '') : '';
    var previewTa = document.getElementById('adminSpecialPreviewText');
    var previewMessage = previewTa ? String(previewTa.value || '') : '';
    if (btn) { btn.disabled = true; btn.textContent = 'Saving...'; }
    renderStatusInto(statusEl, 'success', 'Special Day Posts', 'Saving...');
    fetchJson('/api/admin/ads/special', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: text, preview_message: previewMessage }) })
        .then(function(res) {
            if (res.status !== 'success') {
                renderStatusInto(statusEl, 'error', 'Special Day Posts', res.message || 'Failed to save.');
                return;
            }
            SPECIAL_ADS = Array.isArray(res.special_ads) ? res.special_ads : [];
            SPECIAL_PREVIEW_MESSAGE = typeof res.special_preview_message === 'string' ? res.special_preview_message : SPECIAL_PREVIEW_MESSAGE;
            renderStatusInto(statusEl, 'success', 'Special Day Posts', 'Saved.');
            applyAdsForMode(currentMode());
            updatePreviewMessage();
        })
        .catch(function(err) {
            renderStatusInto(statusEl, 'error', 'Special Day Posts', err && err.message ? err.message : 'Failed to save.');
        })
        .finally(function() {
            if (btn) { btn.disabled = false; btn.textContent = 'Save Special Day Posts'; }
        });
}

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
                    var hint = '';
                    try {
                        if (window && window.location && window.location.protocol === 'https:') {
                            hint = ' Make sure you opened the app from the backend URL and protocol (usually http://127.0.0.1:8000/ not https).';
                        } else {
                            hint = ' Make sure the Python backend is running and you opened the app from it (http://127.0.0.1:8000/).';
                        }
                    } catch (e0) {}
                    throw new Error('Server error (non-JSON).' + hint + ' Response: ' + text.slice(0, 200));
                }
                if (parsed && (parsed.message || parsed.error)) {
                    var extra = '';
                    if (parsed.detail) extra += ' | ' + parsed.detail;
                    if (parsed.raw_response) extra += ' | ' + parsed.raw_response;
                    throw new Error((parsed.message || parsed.error) + extra + ' (HTTP ' + response.status + ')');
                }
                throw new Error('Server error: ' + response.status);
            }

            if (!looksLikeJson) {
                var hint2 = '';
                try {
                    if (window && window.location && window.location.protocol === 'https:') {
                        hint2 = ' Make sure you opened the app from the backend URL and protocol (usually http://127.0.0.1:8000/ not https).';
                    } else {
                        hint2 = ' Make sure the Python backend is running and you opened the app from it (http://127.0.0.1:8000/).';
                    }
                } catch (e1) {}
                throw new Error('Server returned non-JSON.' + hint2 + ' Response: ' + text.slice(0, 200));
            }

            if (parsed) return parsed;
            try {
                return JSON.parse(text);
            } catch (e) {
                throw new Error('Invalid JSON from server. Response: ' + text.slice(0, 200));
            }
        });
    });
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

function summarizeBulkSendResponse(res) {
    var results = (res && Array.isArray(res.results)) ? res.results : [];
    var failed = [];

    for (var i = 0; i < results.length; i++) {
        var it = results[i] || {};
        var to = String(it.to || '');
        if (!to) continue;
        if (it.error) {
            var e = it.error || {};
            var msg = '';
            if (e.type === 'http') {
                msg = 'HTTP ' + String(e.code || '') + ' ' + String(e.reason || '');
                if (e.body) msg += (msg ? ': ' : '') + String(e.body);
            } else {
                msg = String(e.detail || e.body || '');
            }
            msg = msg.trim() || 'Failed';
            failed.push({ to: to, message: msg });
            continue;
        }
        if (it.response && typeof it.response === 'object') {
            var code = String(it.response.code || '').toLowerCase();
            if (code && code !== 'ok') {
                var msg2 = String(it.response.message || it.response.msg || 'Failed');
                failed.push({ to: to, message: msg2 });
            }
        }
    }

    var sent = 0;
    var failedCount = failed.length;
    try { sent = Number(res && res.sent || 0) || 0; } catch (e2) { sent = 0; }
    try {
        var f0 = Number(res && res.failed);
        if (!isNaN(f0)) failedCount = f0;
    } catch (e3) {}

    return {
        sent: sent,
        failed: failedCount,
        partial: !!(res && res.partial),
        failedItems: failed,
        results: results
    };
}

function renderBulkSendStatusInto(el, senderId, message, recipientPhone, res, opts) {
    if (!el) return;
    var sum = summarizeBulkSendResponse(res);

    var type = 'error';
    if (sum.sent > 0) type = 'success';

    var title = 'Failed to send SMS';
    if (sum.sent > 0 && sum.failed === 0) title = 'SMS sent successfully';
    else if (sum.sent > 0 && sum.failed > 0) title = 'SMS sent (partial)';

    var metaLines = [];
    if (senderId) metaLines.push('From: ' + senderId);
    var total = (sum.sent + sum.failed) || 0;
    if (total) metaLines.push('Recipients: ' + String(total));
    if (message) metaLines.push('Message: ' + message);

    if (res && Object.prototype.hasOwnProperty.call(res, 'template_saved')) {
        metaLines.push(res.template_saved ? 'Template: saved' : 'Template: already exists');
    }

    if (opts && Object.prototype.hasOwnProperty.call(opts, 'sms_balance')) {
        metaLines.push('SMS balance: ' + String(opts.sms_balance || 0));
    }

    var meta = metaLines.join('\n');

    var sentBadge = '<span class="badge approved">Sent: ' + escapeHtml(String(sum.sent)) + '</span>';
    var failedBadge = '<span class="badge ' + (sum.failed > 0 ? 'pending' : 'approved') + '">Failed: ' + escapeHtml(String(sum.failed)) + '</span>';

    var detailsHtml = '';
    if (sum.failedItems && sum.failedItems.length) {
        var lines = [];
        var limit = Math.min(60, sum.failedItems.length);
        for (var i = 0; i < limit; i++) {
            var f = sum.failedItems[i];
            lines.push(
                '<div class="send-fail-item">' +
                    '<div class="send-fail-to">' + escapeHtml(String(f.to || '')) + '</div>' +
                    '<div class="send-fail-reason">' + escapeHtml(String(f.message || '')) + '</div>' +
                '</div>'
            );
        }
        var more = sum.failedItems.length > limit ? '<div class="send-fail-more">+' + escapeHtml(String(sum.failedItems.length - limit)) + ' more</div>' : '';
        detailsHtml =
            '<details class="send-details">' +
                '<summary>View failed numbers</summary>' +
                '<div class="send-fail-list">' + lines.join('') + more + '</div>' +
            '</details>';
    }

    el.innerHTML =
        '<div class="status-card ' + (type === 'success' ? 'success' : 'error') + '">' +
            '<div class="status-title">' + escapeHtml(title) + '</div>' +
            '<div class="send-summary">' + sentBadge + failedBadge + '</div>' +
            '<div class="status-meta">' + escapeHtml(meta) + '</div>' +
            detailsHtml +
        '</div>';
}

function renderStatus(type, title, metaText) {
    renderStatusInto(document.getElementById('statusBox'), type, title, metaText);
}

function renderAuthStatus(type, title, metaText) {
    renderStatusInto(document.getElementById('authStatus'), type, title, metaText);
}

function dedupeElementsById(id) {
    var list = document.querySelectorAll('[id="' + String(id || '') + '"]');
    if (!list || list.length <= 1) return;
    for (var i = 0; i < list.length - 1; i++) {
        var el = list[i];
        if (el && el.parentNode) el.parentNode.removeChild(el);
    }
}

function normalizeOtpUiErrorMessage(msg) {
    var s = String(msg || '');
    if (s.indexOf('Not found (HTTP 404)') !== -1 || s.indexOf('Not found') === 0) {
        return 'Backend is not updated. Restart the server and try again.';
    }
    return s || 'Something went wrong. Please try again.';
}

var OTP_RESEND_COOLDOWN_SECONDS = 60;

function otpCooldownKey(purpose, phone) {
    return 'otp_next_send_at:' + String(purpose || '') + ':' + String(phone || '');
}

function otpRemainingSeconds(purpose, phone) {
    var key = otpCooldownKey(purpose, phone);
    var raw = sessionStorage.getItem(key) || '';
    var nextAt = 0;
    try { nextAt = Number(raw || '0'); } catch (e) { nextAt = 0; }
    if (!nextAt) return 0;
    var now = Date.now();
    var ms = nextAt - now;
    if (ms <= 0) return 0;
    return Math.ceil(ms / 1000);
}

function setOtpCooldown(purpose, phone, seconds) {
    var secs = Number(seconds || OTP_RESEND_COOLDOWN_SECONDS);
    if (!secs || secs < 1) secs = OTP_RESEND_COOLDOWN_SECONDS;
    var key = otpCooldownKey(purpose, phone);
    sessionStorage.setItem(key, String(Date.now() + secs * 1000));
}

function renderOtpCooldownUi(purpose, phone, buttonId) {
    var btn = document.getElementById(buttonId);
    if (!btn) return;
    var remaining = otpRemainingSeconds(purpose, phone);
    if (remaining > 0) {
        btn.disabled = true;
        btn.textContent = (buttonId === 'resetStartBtn' ? 'Send OTP' : 'Resend') + ' (' + remaining + 's)';
    } else {
        btn.disabled = false;
        btn.textContent = (buttonId === 'resetStartBtn') ? 'Send OTP' : 'Resend OTP';
    }
}

function startOtpCooldownTimer(purpose, phone, buttonId) {
    var key = 'otp_timer:' + String(purpose || '') + ':' + String(buttonId || '');
    try {
        var prev = window[key];
        if (prev) clearInterval(prev);
    } catch (e) {}
    renderOtpCooldownUi(purpose, phone, buttonId);
    window[key] = setInterval(function() {
        var remaining = otpRemainingSeconds(purpose, phone);
        renderOtpCooldownUi(purpose, phone, buttonId);
        if (remaining <= 0) {
            try { clearInterval(window[key]); } catch (e) {}
            window[key] = null;
        }
    }, 500);
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

function updatePreviewMessage() {
    var mode = currentMode();
    var messageInput = mode === 'special' ? document.getElementById('specialMessage') : document.getElementById('Message1');
    if (!messageInput) return;
    var messageText = String(messageInput.value || '');
    var fallback = DEFAULT_PREVIEW_MESSAGE;
    if (mode === 'special') {
        fallback = SPECIAL_PREVIEW_MESSAGE || DEFAULT_PREVIEW_MESSAGE;
    } else {
        fallback = HOME_PREVIEW_MESSAGE || DEFAULT_PREVIEW_MESSAGE;
    }
    var messageElements = document.querySelectorAll('.message p');
    messageElements.forEach(function(element) {
        element.textContent = messageText || fallback;
    });
}

function saveHomePreview() {
    var previewTa = document.getElementById('adminHomePreviewText');
    var btn = document.getElementById('saveHomePreviewBtn');
    var statusEl = document.getElementById('adminHomePreviewStatus');
    var textTa = document.getElementById('adminHomeAdsText');
    var text = textTa ? String(textTa.value || '') : '';
    var previewMessage = previewTa ? String(previewTa.value || '') : '';
    if (btn) { btn.disabled = true; btn.textContent = 'Saving...'; }
    renderStatusInto(statusEl, 'success', 'Personal Brand Post', 'Saving...');
    fetchJson('/api/admin/ads/home', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: text, preview_message: previewMessage }) })
        .then(function(res) {
            if (res.status !== 'success') {
                renderStatusInto(statusEl, 'error', 'Personal Brand Post', res.message || 'Failed to save.');
                return;
            }
            HOME_PREVIEW_MESSAGE = typeof res.home_preview_message === 'string' ? res.home_preview_message : HOME_PREVIEW_MESSAGE;
            renderStatusInto(statusEl, 'success', 'Personal Brand Post', 'Saved.');
            updatePreviewMessage();
        })
        .catch(function(err) {
            renderStatusInto(statusEl, 'error', 'Personal Brand Post', err && err.message ? err.message : 'Failed to save.');
        })
        .finally(function() {
            if (btn) { btn.disabled = false; btn.textContent = 'Save Personal Brand Post'; }
        });
}

function saveSpecialPreview() {
    var previewTa = document.getElementById('adminSpecialPreviewText');
    var btn = document.getElementById('saveSpecialPreviewBtn');
    var statusEl = document.getElementById('adminSpecialPreviewStatus');
    var textTa = document.getElementById('adminSpecialAdsText');
    var text = textTa ? String(textTa.value || '') : '';
    var previewMessage = previewTa ? String(previewTa.value || '') : '';
    if (btn) { btn.disabled = true; btn.textContent = 'Saving...'; }
    renderStatusInto(statusEl, 'success', 'Special Day Post', 'Saving...');
    fetchJson('/api/admin/ads/special', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: text, preview_message: previewMessage }) })
        .then(function(res) {
            if (res.status !== 'success') {
                renderStatusInto(statusEl, 'error', 'Special Day Post', res.message || 'Failed to save.');
                return;
            }
            SPECIAL_PREVIEW_MESSAGE = typeof res.special_preview_message === 'string' ? res.special_preview_message : SPECIAL_PREVIEW_MESSAGE;
            renderStatusInto(statusEl, 'success', 'Special Day Post', 'Saved.');
            updatePreviewMessage();
        })
        .catch(function(err) {
            renderStatusInto(statusEl, 'error', 'Special Day Post', err && err.message ? err.message : 'Failed to save.');
        })
        .finally(function() {
            if (btn) { btn.disabled = false; btn.textContent = 'Save Special Day Post'; }
        });
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

function setLoggedOutUI() {
    CURRENT_SESSION = null;
    renderSmsBalanceBadge(null);
    var loginBox = document.getElementById('loginBox');
    var smsBox = document.getElementById('smsBox');
    var specialDayBox = document.getElementById('specialDayBox');
    var brandnamesBox = document.getElementById('brandnamesBox');
    var subscriptionBox = document.getElementById('subscriptionBox');
    var aboutBox = document.getElementById('aboutBox');
    var adminTemplatesBox = document.getElementById('adminTemplatesBox');
    var templatesPage = document.getElementById('templates-page');
    var logoutLink = document.getElementById('logoutLink');
    var brandnamesLink = document.getElementById('brandnamesLink');
    var specialDayLink = document.getElementById('specialDayLink');
    var subscriptionLink = document.getElementById('subscriptionLink');
    var brandHeader = document.getElementById('brandHeader');
    var previewSender = document.getElementById('previewSender');

    if (loginBox) loginBox.style.display = '';
    if (smsBox) smsBox.style.display = 'none';
    if (specialDayBox) specialDayBox.style.display = 'none';
    if (brandnamesBox) brandnamesBox.style.display = 'none';
    if (subscriptionBox) subscriptionBox.style.display = 'none';
    if (aboutBox) aboutBox.style.display = 'none';
    if (adminTemplatesBox) adminTemplatesBox.style.display = 'none';
    if (templatesPage) templatesPage.style.display = 'none';
    if (logoutLink) logoutLink.style.display = 'none';
    if (brandnamesLink) brandnamesLink.style.display = 'none';
    if (specialDayLink) specialDayLink.style.display = 'none';
    if (subscriptionLink) subscriptionLink.style.display = '';
    if (brandHeader) brandHeader.textContent = 'Inbox';
    if (previewSender) previewSender.textContent = 'Sender';
    stopAdminAdsTicker();
    var banner2 = document.getElementById('adminAdsBanner');
    if (banner2) banner2.style.display = 'none';

    clearBox('statusBox');
    clearBox('specialStatusBox');
    clearBox('senderIdList');
    clearBox('pendingSenderIds');
    clearBox('specialDayList');
    clearBox('adminTemplateStatus');

    var senderSelect = document.getElementById('senderIdSelect');
    if (senderSelect) senderSelect.innerHTML = '';
    var specialSelect = document.getElementById('specialSender');
    if (specialSelect) specialSelect.innerHTML = '';
    var specialDatalist = document.getElementById('specialDayIds');
    if (specialDatalist) specialDatalist.innerHTML = '';

    var path = String((window.location && window.location.pathname) || '').toLowerCase();
    if (path.endsWith('/template.html') || path.endsWith('template.html')) {
        window.location.href = 'index.html';
    }
}

function setLoggedInUI(session) {
    CURRENT_SESSION = session || null;
    renderSmsBalanceBadge(session);
    var loginBox = document.getElementById('loginBox');
    var logoutLink = document.getElementById('logoutLink');
    var brandnamesLink = document.getElementById('brandnamesLink');
    var specialDayLink = document.getElementById('specialDayLink');
    var subscriptionLink = document.getElementById('subscriptionLink');
    var brandHeader = document.getElementById('brandHeader');
    var senderElements = document.querySelectorAll('.sender');
    var adminTemplatesBox = document.getElementById('adminTemplatesBox');
    var adminSpecialAdsBox = document.getElementById('adminSpecialAdsBox');
    var adminHomeAdsBox = document.getElementById('adminHomeAdsBox');

    if (loginBox) loginBox.style.display = 'none';
    if (logoutLink) logoutLink.style.display = '';

    var displayBrand = session && session.brandname ? session.brandname : '';
    var displayName = session && session.name ? String(session.name) : '';
    if (brandHeader) brandHeader.textContent = displayBrand ? (displayBrand + ' Inbox') : (displayName ? (displayName + ' Inbox') : 'Inbox');
    senderElements.forEach(function(el) { el.textContent = displayBrand || 'Sender'; });

    if (brandnamesLink) brandnamesLink.style.display = session && session.is_admin ? '' : 'none';
    if (specialDayLink) specialDayLink.style.display = '';
    if (subscriptionLink) subscriptionLink.style.display = '';

    clearBox('statusBox');

    renderSenderIds(session && session.sender_ids ? session.sender_ids : []);
    renderSpecialDays(session && session.special_day_sender_ids ? session.special_day_sender_ids : []);
    renderSpecialDayDatalist(session && session.special_day_sender_ids ? session.special_day_sender_ids : []);

    if (session && session.is_admin) {
        if (adminSpecialAdsBox) adminSpecialAdsBox.style.display = '';
        if (adminHomeAdsBox) adminHomeAdsBox.style.display = '';
        refreshUsers();
        refreshPendingSenderIds();
        refreshSpecialDayList();
        if (adminTemplatesBox) adminTemplatesBox.style.display = '';
    } else {
        if (adminSpecialAdsBox) adminSpecialAdsBox.style.display = 'none';
        if (adminHomeAdsBox) adminHomeAdsBox.style.display = 'none';
        if (adminTemplatesBox) adminTemplatesBox.style.display = 'none';
    }
}

function clearBox(id) {
    var el = document.getElementById(id);
    if (el) el.innerHTML = '';
}

function fetchSession() {
    var prev = CURRENT_SESSION;
    var tries = 0;

    function run() {
        return fetchJson('/api/session', { method: 'GET' })
            .then(function(data) {
                if (!data || data.status !== 'success') {
                    setLoggedOutUI();
                    return null;
                }
                if (data.logged_in) {
                    setLoggedInUI(data);
                    return data;
                }
                setLoggedOutUI();
                return null;
            })
            .catch(function() {
                if (tries < 1) {
                    tries += 1;
                    return run();
                }
                if (prev && prev.logged_in) {
                    return prev;
                }
                setLoggedOutUI();
                return null;
            });
    }

    return run();
}

function otpBoxesValue(containerId) {
    var root = document.getElementById(containerId);
    if (!root) return '';
    var inputs = root.querySelectorAll('input');
    var out = '';
    for (var i = 0; i < inputs.length; i++) {
        out += String(inputs[i].value || '').replace(/\D/g, '').slice(0, 1);
    }
    return out;
}

function initOtpBoxes(containerId) {
    var root = document.getElementById(containerId);
    if (!root) return;
    var inputs = root.querySelectorAll('input');
    for (var i = 0; i < inputs.length; i++) {
        (function(idx) {
            var el = inputs[idx];
            if (!el) return;
            el.addEventListener('input', function() {
                el.value = String(el.value || '').replace(/\D/g, '').slice(0, 1);
                if (el.value && inputs[idx + 1]) inputs[idx + 1].focus();
            });
            el.addEventListener('keydown', function(e) {
                if (e && e.key === 'Backspace' && !el.value && inputs[idx - 1]) {
                    inputs[idx - 1].focus();
                }
            });
        })(i);
    }
}

function signupContinue() {
    var name = ((document.getElementById('signupName') || {}).value || '').trim();
    var phone = ((document.getElementById('signupPhone') || {}).value || '').trim();
    var password = ((document.getElementById('signupPassword') || {}).value || '');
    var btn = document.getElementById('signupContinueBtn');
    var statusEl = document.getElementById('signupStatus');
    if (!name || !phone || !password) {
        renderStatusInto(statusEl, 'error', 'Create Account', 'Enter name, phone number and password.');
        return;
    }
    var remaining = otpRemainingSeconds('signup', phone);
    if (remaining > 0) {
        renderStatusInto(statusEl, 'error', 'Wait', 'Try again in ' + remaining + ' seconds.');
        return;
    }
    sessionStorage.setItem('signup_name', name);
    sessionStorage.setItem('signup_phone', phone);
    sessionStorage.setItem('signup_password', password);
    if (btn) { btn.disabled = true; btn.textContent = 'Sending...'; }
    renderStatusInto(statusEl, 'success', 'Sending OTP...', 'Please wait.');
    fetchJson('/api/signup/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: name, phone: phone, password: password })
    })
        .then(function(res) {
            if (btn) { btn.disabled = false; btn.textContent = 'Continue'; }
            if (res.status === 'success') {
                setOtpCooldown('signup', phone, OTP_RESEND_COOLDOWN_SECONDS);
                window.location.href = 'index.html?mode=otp';
                return;
            }
            renderStatusInto(statusEl, 'error', 'OTP failed', res.message || 'Failed to send OTP.');
        })
        .catch(function(err) {
            if (btn) { btn.disabled = false; btn.textContent = 'Continue'; }
            renderStatusInto(statusEl, 'error', 'OTP failed', normalizeOtpUiErrorMessage(err && err.message ? err.message : ''));
        });
}

function otpVerify() {
    var phone = (sessionStorage.getItem('signup_phone') || '').trim();
    var otp = otpBoxesValue('otpInputs');
    var btn = document.getElementById('otpVerifyBtn');
    var statusEl = document.getElementById('otpStatus');
    if (!phone) {
        renderStatusInto(statusEl, 'error', 'Verify OTP', 'Missing phone number. Go back and enter your details.');
        return;
    }
    if (!otp || otp.length !== 6) {
        renderStatusInto(statusEl, 'error', 'Verify OTP', 'Enter the 6-digit code.');
        return;
    }
    if (btn) { btn.disabled = true; btn.textContent = 'Verifying...'; }
    renderStatusInto(statusEl, 'success', 'Verifying...', 'Please wait.');
    fetchJson('/api/signup/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ phone: phone, otp: otp })
    })
        .then(function(res) {
            if (btn) { btn.disabled = false; btn.textContent = 'Verify'; }
            if (res.status === 'success' && res.logged_in) {
                setLoggedInUI(res);
                sessionStorage.removeItem('signup_name');
                sessionStorage.removeItem('signup_phone');
                sessionStorage.removeItem('signup_password');
                window.location.href = 'index.html';
                return;
            }
            renderStatusInto(statusEl, 'error', 'Verify failed', res.message || 'Failed to verify OTP.');
        })
        .catch(function(err) {
            if (btn) { btn.disabled = false; btn.textContent = 'Verify'; }
            renderStatusInto(statusEl, 'error', 'Verify failed', err && err.message ? err.message : 'Failed to verify OTP.');
        });
}

function otpResend() {
    var name = (sessionStorage.getItem('signup_name') || '').trim();
    var phone = (sessionStorage.getItem('signup_phone') || '').trim();
    var password = sessionStorage.getItem('signup_password') || '';
    var statusEl = document.getElementById('otpStatus');
    if (!name || !phone || !password) {
        renderStatusInto(statusEl, 'error', 'Resend OTP', 'Go back and enter your details.');
        return;
    }
    var remaining = otpRemainingSeconds('signup', phone);
    if (remaining > 0) {
        renderStatusInto(statusEl, 'error', 'Wait', 'Try again in ' + remaining + ' seconds.');
        return;
    }
    renderStatusInto(statusEl, 'success', 'Sending OTP...', 'Please wait.');
    fetchJson('/api/signup/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: name, phone: phone, password: password })
    })
        .then(function(res) {
            if (res.status === 'success') {
                setOtpCooldown('signup', phone, OTP_RESEND_COOLDOWN_SECONDS);
                startOtpCooldownTimer('signup', phone, 'otpResendBtn');
                renderStatusInto(statusEl, 'success', 'OTP sent', 'Check your phone and enter the code.');
                return;
            }
            renderStatusInto(statusEl, 'error', 'OTP failed', res.message || 'Failed to send OTP.');
        })
        .catch(function(err) {
            renderStatusInto(statusEl, 'error', 'OTP failed', normalizeOtpUiErrorMessage(err && err.message ? err.message : ''));
        });
}

function resetSetStep(step) {
    var s = String(step || '').toLowerCase();
    var phoneStep = document.getElementById('resetStepPhone');
    var otpStep = document.getElementById('resetStepOtp');
    var passwordStep = document.getElementById('resetStepPassword');
    if (phoneStep) phoneStep.style.display = (s === 'phone') ? '' : 'none';
    if (otpStep) otpStep.style.display = (s === 'otp') ? '' : 'none';
    if (passwordStep) passwordStep.style.display = (s === 'password') ? '' : 'none';

    try {
        if (s === 'otp') {
            var first = document.querySelector('#resetOtpInputs input');
            if (first) first.focus();
        } else if (s === 'password') {
            var np = document.getElementById('resetNewPassword');
            if (np) np.focus();
        } else {
            var ph = document.getElementById('resetPhone');
            if (ph) ph.focus();
        }
    } catch (e) {}
}

function resetClearOtpBoxes() {
    var root = document.getElementById('resetOtpInputs');
    if (!root) return;
    var inputs = root.querySelectorAll('input');
    for (var i = 0; i < inputs.length; i++) {
        inputs[i].value = '';
    }
}

function resetInitUi() {
    var phone = (sessionStorage.getItem('reset_phone') || ((document.getElementById('resetPhone') || {}).value || '')).trim();
    var verified = (sessionStorage.getItem('reset_otp_verified') || '') === '1';
    var step = 'phone';
    if (phone) step = verified ? 'password' : 'otp';
    resetSetStep(step);

    var sub = document.getElementById('resetOtpSubtitle');
    if (sub) sub.textContent = phone ? ('Enter the 6-digit code sent to ' + phone) : 'Enter the 6-digit code';

    if (phone) {
        startOtpCooldownTimer('reset', phone, 'resetStartBtn');
        startOtpCooldownTimer('reset', phone, 'resetResendBtn');
    }
}

function resetStart() {
    var phone = ((document.getElementById('resetPhone') || {}).value || '').trim();
    if (!phone) phone = (sessionStorage.getItem('reset_phone') || '').trim();
    var btn = document.getElementById('resetStartBtn');
    var btn2 = document.getElementById('resetResendBtn');
    var statusEl = document.getElementById('resetStatus');
    if (!phone) {
        renderStatusInto(statusEl, 'error', 'Reset Password', 'Enter your phone number.');
        return;
    }
    var remaining = otpRemainingSeconds('reset', phone);
    if (remaining > 0) {
        renderStatusInto(statusEl, 'error', 'Wait', 'Try again in ' + remaining + ' seconds.');
        return;
    }
    sessionStorage.setItem('reset_phone', phone);
    sessionStorage.removeItem('reset_otp_verified');
    sessionStorage.setItem('reset_step', 'otp');
    if (btn) { btn.disabled = true; btn.textContent = 'Sending...'; }
    if (btn2) { btn2.disabled = true; btn2.textContent = 'Sending...'; }
    renderStatusInto(statusEl, 'success', 'Sending OTP...', 'Please wait.');
    fetchJson('/api/password-reset/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ phone: phone })
    })
        .then(function(res) {
            if (btn) { btn.disabled = false; btn.textContent = 'Send OTP'; }
            if (btn2) { btn2.disabled = false; btn2.textContent = 'Resend OTP'; }
            if (res.status === 'success') {
                setOtpCooldown('reset', phone, OTP_RESEND_COOLDOWN_SECONDS);
                startOtpCooldownTimer('reset', phone, 'resetStartBtn');
                startOtpCooldownTimer('reset', phone, 'resetResendBtn');
                resetClearOtpBoxes();
                var pw = document.getElementById('resetNewPassword');
                if (pw) pw.value = '';
                var sub = document.getElementById('resetOtpSubtitle');
                if (sub) sub.textContent = 'Enter the 6-digit code sent to ' + phone;
                resetSetStep('otp');
                renderStatusInto(statusEl, 'success', 'OTP sent', 'Enter the 6-digit code.');
                return;
            }
            renderStatusInto(statusEl, 'error', 'OTP failed', res.message || 'Failed to send OTP.');
        })
        .catch(function(err) {
            if (btn) { btn.disabled = false; btn.textContent = 'Send OTP'; }
            if (btn2) { btn2.disabled = false; btn2.textContent = 'Resend OTP'; }
            renderStatusInto(statusEl, 'error', 'OTP failed', normalizeOtpUiErrorMessage(err && err.message ? err.message : ''));
        });
}

function resetOtpVerify() {
    var phone = (sessionStorage.getItem('reset_phone') || ((document.getElementById('resetPhone') || {}).value || '')).trim();
    var otp = otpBoxesValue('resetOtpInputs');
    var btn = document.getElementById('resetOtpVerifyBtn');
    var statusEl = document.getElementById('resetStatus');
    if (!phone) {
        renderStatusInto(statusEl, 'error', 'Verify OTP', 'Enter your phone number and request an OTP.');
        resetSetStep('phone');
        return;
    }
    if (!otp || otp.length !== 6) {
        renderStatusInto(statusEl, 'error', 'Verify OTP', 'Enter the 6-digit code.');
        return;
    }
    if (btn) { btn.disabled = true; btn.textContent = 'Verifying...'; }
    renderStatusInto(statusEl, 'success', 'Verifying...', 'Please wait.');
    fetchJson('/api/password-reset/check', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ phone: phone, otp: otp })
    })
        .then(function(res) {
            if (btn) { btn.disabled = false; btn.textContent = 'Verify OTP'; }
            if (res.status === 'success') {
                sessionStorage.setItem('reset_otp_verified', '1');
                sessionStorage.setItem('reset_step', 'password');
                resetSetStep('password');
                renderStatusInto(statusEl, 'success', 'OTP verified', 'Enter your new password.');
                return;
            }
            renderStatusInto(statusEl, 'error', 'Verify failed', res.message || 'Failed to verify OTP.');
        })
        .catch(function(err) {
            if (btn) { btn.disabled = false; btn.textContent = 'Verify OTP'; }
            renderStatusInto(statusEl, 'error', 'Verify failed', normalizeOtpUiErrorMessage(err && err.message ? err.message : ''));
        });
}

function resetVerify() {
    var phone = (sessionStorage.getItem('reset_phone') || ((document.getElementById('resetPhone') || {}).value || '')).trim();
    var otp = otpBoxesValue('resetOtpInputs');
    var newPassword = ((document.getElementById('resetNewPassword') || {}).value || '');
    var btn = document.getElementById('resetVerifyBtn');
    var statusEl = document.getElementById('resetStatus');
    if ((sessionStorage.getItem('reset_otp_verified') || '') !== '1') {
        renderStatusInto(statusEl, 'error', 'Reset Password', 'Verify the OTP first.');
        resetSetStep('otp');
        return;
    }
    if (!phone || !otp || otp.length !== 6 || !newPassword) {
        renderStatusInto(statusEl, 'error', 'Reset Password', 'Enter phone, OTP, and new password.');
        return;
    }
    if (btn) { btn.disabled = true; btn.textContent = 'Resetting...'; }
    renderStatusInto(statusEl, 'success', 'Resetting...', 'Please wait.');
    fetchJson('/api/password-reset/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ phone: phone, otp: otp, newPassword: newPassword })
    })
        .then(function(res) {
            if (btn) { btn.disabled = false; btn.textContent = 'Reset Password'; }
            if (res.status === 'success' && res.logged_in) {
                setLoggedInUI(res);
                sessionStorage.removeItem('reset_phone');
                sessionStorage.removeItem('reset_step');
                sessionStorage.removeItem('reset_otp_verified');
                window.location.href = 'index.html';
                return;
            }
            renderStatusInto(statusEl, 'error', 'Reset failed', res.message || 'Failed to reset password.');
        })
        .catch(function(err) {
            if (btn) { btn.disabled = false; btn.textContent = 'Reset Password'; }
            renderStatusInto(statusEl, 'error', 'Reset failed', err && err.message ? err.message : 'Failed to reset password.');
        });
}

function login() {
    var username = (document.getElementById('loginUsername') || {}).value || '';
    var password = (document.getElementById('loginPassword') || {}).value || '';
    username = username.trim();
    if (!username || !password) {
        renderAuthStatus('error', 'Login', 'Enter phone number and password.');
        return;
    }

    fetchJson('/api/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: username, password: password })
    })
        .then(function(res) {
            if (res.status === 'success' && res.logged_in) {
                setLoggedInUI(res);
                var passwordEl = document.getElementById('loginPassword');
                if (passwordEl) passwordEl.value = '';
                applyTemplateToMessageIfAny();
                if (window.history && window.history.replaceState) {
                    window.history.replaceState(null, '', 'index.html');
                }
                showMode('', res);
                return;
            }
            renderAuthStatus('error', 'Login failed', res.message || 'Login failed');
        })
        .catch(function(err) {
            renderAuthStatus('error', 'Login failed', err && err.message ? err.message : 'Login failed');
        });
}

function logout() {
    fetchJson('/api/logout', { method: 'POST' })
        .then(function() {
            setLoggedOutUI();
            var path = String((window.location && window.location.pathname) || '').toLowerCase();
            if (path.endsWith('/template.html') || path.endsWith('template.html')) {
                window.location.href = 'index.html';
            }
        })
        .catch(function() {
            setLoggedOutUI();
            var path = String((window.location && window.location.pathname) || '').toLowerCase();
            if (path.endsWith('/template.html') || path.endsWith('template.html')) {
                window.location.href = 'index.html';
            }
        });
}

function currentMode() {
    var params = new URLSearchParams(window.location.search || '');
    return (params.get('mode') || '').toLowerCase();
}



function renderSubscriptionPlans() {
    var plansEl = document.getElementById('subscriptionPlans');
    if (!plansEl) return;
    var selected = SELECTED_SUBSCRIPTION_SMS;
    if (!selected && SUBSCRIPTION_PLANS.length) selected = SUBSCRIPTION_PLANS[0].sms;
    SELECTED_SUBSCRIPTION_SMS = selected;

    plansEl.innerHTML = SUBSCRIPTION_PLANS.map(function(t) {
        var isSelected = String(t.sms) === String(selected);
        var title = String(t.sms) + ' SMS';
        var meta = 'SMS bundle: ' + String(t.sms);
        return (
            '<div class="plan-card' + (isSelected ? ' selected' : '') + '" data-sms="' + escapeHtml(String(t.sms)) + '" data-price="' + escapeHtml(String(t.price)) + '">' +
                '<div class="plan-top">' +
                    '<div class="plan-name">' + escapeHtml(title) + '</div>' +
                    '<div class="plan-price">' + escapeHtml(PRICE_CURRENCY_LABEL + String(t.price)) + '</div>' +
                '</div>' +
                '<div class="plan-meta">' + escapeHtml(meta) + '</div>' +
                '<div class="plan-actions">' +
                    '<button class="plan-btn js-select-plan" data-sms="' + escapeHtml(String(t.sms)) + '">Choose</button>' +
                    '<button class="plan-btn primary js-buy-plan" data-sms="' + escapeHtml(String(t.sms)) + '" data-price="' + escapeHtml(String(t.price)) + '">Buy</button>' +
                '</div>' +
            '</div>'
        );
    }).join('');
}

function verifyPaystackReference(reference) {
    var ref = String(reference || '').trim();
    if (!ref) return;
    var statusEl = document.getElementById('subscriptionStatus');
    renderStatusInto(statusEl, 'success', 'Verifying payment...', 'Please wait.');
    fetchJson('/api/paystack/verify?reference=' + encodeURIComponent(ref), { method: 'GET' })
        .then(function(res) {
            if (res.status !== 'success') {
                renderStatusInto(statusEl, 'error', 'Payment failed', res.message || 'Failed to verify payment.');
                return;
            }
            var meta = 'Reference: ' + (res.reference || ref);
            if (Object.prototype.hasOwnProperty.call(res, 'credited_sms')) {
                meta += '\nSMS added: ' + String(res.credited_sms || 0);
            }
            if (Object.prototype.hasOwnProperty.call(res, 'sms_balance')) {
                meta += '\nNew balance: ' + String(res.sms_balance || 0) + ' SMS';
            }
            renderStatusInto(statusEl, 'success', 'Payment successful', meta);
            if (CURRENT_SESSION && !CURRENT_SESSION.is_admin && !CURRENT_SESSION.is_free && Object.prototype.hasOwnProperty.call(res, 'sms_balance')) {
                CURRENT_SESSION.sms_credits = res.sms_balance;
                renderSmsBalanceBadge(CURRENT_SESSION);
            }
        })
        .catch(function(err) {
            renderStatusInto(statusEl, 'error', 'Payment failed', err && err.message ? err.message : 'Failed to verify payment.');
        })
        .finally(function() {
            try {
                var url = new URL(window.location.href);
                url.searchParams.delete('reference');
                url.searchParams.delete('trxref');
                if (window.history && window.history.replaceState) {
                    window.history.replaceState(null, '', url.pathname + url.search);
                }
            } catch (e) {}
        });
}

function showMode(mode, session) {
    var loginBox = document.getElementById('loginBox');
    var signupPage = document.getElementById('signupPage');
    var otpPage = document.getElementById('otpPage');
    var resetPage = document.getElementById('resetPage');
    var iphonePreview = document.getElementById('iphonePreview');
    var smsBox = document.getElementById('smsBox');
    var specialDayBox = document.getElementById('specialDayBox');
    var brandnamesBox = document.getElementById('brandnamesBox');
    var subscriptionBox = document.getElementById('subscriptionBox');
    var aboutBox = document.getElementById('aboutBox');
    var brandHeader = document.getElementById('brandHeader');

    try {
        if (document.body) document.body.classList.remove('mode-brandnames');
    } catch (e) {}

    if (loginBox) loginBox.style.display = 'none';
    if (signupPage) signupPage.style.display = 'none';
    if (otpPage) otpPage.style.display = 'none';
    if (resetPage) resetPage.style.display = 'none';
    if (smsBox) smsBox.style.display = 'none';
    if (specialDayBox) specialDayBox.style.display = 'none';
    if (brandnamesBox) brandnamesBox.style.display = 'none';
    if (subscriptionBox) subscriptionBox.style.display = 'none';
    if (aboutBox) aboutBox.style.display = 'none';
    stopAdminAdsTicker();
    var banner2 = document.getElementById('adminAdsBanner');
    if (banner2) banner2.style.display = 'none';

    if (brandHeader) {
        if (mode === 'subscription') document.title = 'Top up';
        else if (mode === 'about') document.title = 'About';
        else if (mode === 'signup') document.title = 'Create Account';
        else if (mode === 'otp') document.title = 'Verify OTP';
        else if (mode === 'reset') document.title = 'Reset Password';
        else document.title = 'Business SMS';
    }

    if (mode === 'signup') {
        if (signupPage) signupPage.style.display = '';
        if (brandHeader) brandHeader.textContent = 'Create Account';
        return;
    }

    if (mode === 'otp') {
        if (otpPage) otpPage.style.display = '';
        initOtpBoxes('otpInputs');
        var p = (sessionStorage.getItem('signup_phone') || '').trim();
        var sub = document.getElementById('otpSubtitle');
        if (sub) sub.textContent = p ? ('Enter the 6-digit code sent to ' + p) : 'Enter the 6-digit code';
        if (p) startOtpCooldownTimer('signup', p, 'otpResendBtn');
        if (brandHeader) brandHeader.textContent = 'Verify OTP';
        return;
    }

    if (mode === 'reset') {
        if (resetPage) resetPage.style.display = '';
        initOtpBoxes('resetOtpInputs');
        resetInitUi();
        if (brandHeader) brandHeader.textContent = 'Reset Password';
        return;
    }

    if (mode === 'subscription') {
        if (subscriptionBox) subscriptionBox.style.display = '';
        if (brandHeader) brandHeader.textContent = 'Top up';
        if (!session || !session.logged_in) {
            if (loginBox) loginBox.style.display = '';
        }
        renderSubscriptionPlans();
        return;
    }

    if (mode === 'about') {
        if (aboutBox) aboutBox.style.display = '';
        if (brandHeader) brandHeader.textContent = 'About';
        if (iphonePreview) iphonePreview.style.display = 'none';
        return;
    }

    if (!session || !session.logged_in) {
        if (loginBox) loginBox.style.display = '';
        if (brandHeader) brandHeader.textContent = 'Inbox';
        return;
    }

    if (mode === 'special') {
        if (specialDayBox) specialDayBox.style.display = '';
        if (brandHeader) brandHeader.textContent = 'Special Day';
        if (iphonePreview) iphonePreview.style.display = '';
        applyAdsForMode('special');
        return;
    }

    if (mode === 'brandnames') {
        if (session.is_admin) {
            if (brandnamesBox) brandnamesBox.style.display = '';
            if (brandHeader) brandHeader.textContent = 'Brandnames';
            if (iphonePreview) iphonePreview.style.display = 'none';
            try {
                if (document.body) document.body.classList.add('mode-brandnames');
            } catch (e) {}
            setBrandTab(getBrandTab());
            return;
        }
    }

    if (iphonePreview) iphonePreview.style.display = '';

    if (smsBox) smsBox.style.display = '';
    applyAdsForMode('home');
    var displayBrand = session && session.brandname ? session.brandname : '';
    var displayName = session && session.name ? String(session.name) : '';
    if (brandHeader) brandHeader.textContent = displayBrand ? (displayBrand + ' Inbox') : (displayName ? (displayName + ' Inbox') : 'Inbox');
}

function sendSMS() {
    var senderSelect = document.getElementById('senderIdSelect');
    var messageEl = document.getElementById('Message1');
    var phoneEl = document.getElementById('recipientPhone');
    var sendBtn = document.getElementById('sendBtn');

    var senderId = senderSelect ? senderSelect.value : '';
    var message = messageEl ? messageEl.value.trim() : '';
    var recipientPhone = phoneEl ? phoneEl.value.trim() : '';

    if (!senderId || !message || !recipientPhone) {
        renderStatus('error', 'Fill all fields', 'Choose Sender ID, enter message and customer phone number.');
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
        body: JSON.stringify({ senderId: senderId, message: message, recipientPhone: recipientPhone })
    })
        .then(function(res) {
            if (sendBtn) {
                sendBtn.disabled = false;
                sendBtn.textContent = 'Send';
            }
            if (res.status === 'success') {
                if (Object.prototype.hasOwnProperty.call(res, 'sms_balance')) {
                    if (CURRENT_SESSION && !CURRENT_SESSION.is_admin && !CURRENT_SESSION.is_free) {
                        CURRENT_SESSION.sms_credits = res.sms_balance;
                        renderSmsBalanceBadge(CURRENT_SESSION);
                    }
                }
                if (Object.prototype.hasOwnProperty.call(res, 'sent') || Object.prototype.hasOwnProperty.call(res, 'failed') || Object.prototype.hasOwnProperty.call(res, 'partial') || Object.prototype.hasOwnProperty.call(res, 'results')) {
                    renderBulkSendStatusInto(document.getElementById('statusBox'), senderId, message, recipientPhone, res, { sms_balance: res.sms_balance });
                } else {
                    var meta = 'From: ' + senderId + '\nTo: ' + recipientPhone + '\nMessage: ' + message;
                    if (Object.prototype.hasOwnProperty.call(res, 'template_saved')) {
                        meta += res.template_saved ? '\nTemplate: saved' : '\nTemplate: already exists';
                    }
                    if (Object.prototype.hasOwnProperty.call(res, 'sms_balance')) {
                        meta += '\nSMS balance: ' + String(res.sms_balance || 0);
                    }
                    renderStatus('success', 'SMS sent successfully', meta);
                }
                return;
            }
            if (res.message === 'Not logged in') {
                renderStatus('error', 'Session expired', 'Please login again.');
                setLoggedOutUI();
                return;
            }
            if (res && Object.prototype.hasOwnProperty.call(res, 'results')) {
                renderBulkSendStatusInto(document.getElementById('statusBox'), senderId, message, recipientPhone, res, { sms_balance: res.sms_balance });
                return;
            }
            var meta2 = (res.message || 'Unknown error') + (res.detail ? '\n' + res.detail : '') + (res.raw_response ? '\n' + res.raw_response : '');
            renderStatus('error', 'Failed to send SMS', meta2);
        })
        .catch(function(err) {
            if (sendBtn) {
                sendBtn.disabled = false;
                sendBtn.textContent = 'Send';
            }
            renderStatus('error', 'Error', err && err.message ? err.message : 'An error occurred while sending the SMS.');
        });
}

function renderSenderIds(senderIds) {
    var select = document.getElementById('senderIdSelect');
    var list = document.getElementById('senderIdList');
    if (select) select.innerHTML = '';
    if (!list) return;

    var items = Array.isArray(senderIds) ? senderIds : [];
    var approved = items.filter(function(s) { return s && s.status === 'approved' && s.name; });

    if (select) {
        if (approved.length === 0) {
            select.innerHTML = '<option value="">No approved Sender ID</option>';
        } else {
            select.innerHTML = approved.map(function(s) {
                return '<option value="' + escapeHtml(s.name) + '">' + escapeHtml(s.name) + '</option>';
            }).join('');
        }
    }

    if (items.length === 0) {
        list.innerHTML = '<div class="pill-row"><div class="pill-left"><div class="pill-name">No Sender IDs yet</div><div class="pill-status">Create one and wait for admin approval</div></div><span class="badge pending">Pending</span></div>';
        return;
    }

    list.innerHTML = items.map(function(s) {
        var status = s.status === 'approved' ? 'approved' : 'pending';
        var badgeText = s.status === 'approved' ? 'Verified' : 'Pending';
        return (
            '<div class="pill-row">' +
                '<div class="pill-left">' +
                    '<div class="pill-name">' + escapeHtml(s.name || '') + '</div>' +
                    '<div class="pill-status">' + escapeHtml(s.status || '') + '</div>' +
                '</div>' +
                '<span class="badge ' + status + '">' + badgeText + '</span>' +
            '</div>'
        );
    }).join('');
}

function createSenderId() {
    var input = document.getElementById('newSenderId');
    var btn = document.getElementById('createSenderIdBtn');
    var name = input ? input.value.trim() : '';
    if (!name) {
        renderStatus('error', 'Sender ID', 'Enter a Sender ID (max 11).');
        return;
    }
    if (btn) {
        btn.disabled = true;
        btn.textContent = 'Creating...';
    }
    fetchJson('/api/sender-ids', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: name })
    })
        .then(function(res) {
            if (btn) {
                btn.disabled = false;
                btn.textContent = 'Create';
            }
            if (res.status === 'success') {
                if (input) input.value = '';
                renderStatus('success', 'Sender ID', 'Created and pending approval.');
                fetchSession().then(function(s) { showMode(currentMode(), s); });
                return;
            }
            renderStatus('error', 'Sender ID', res.message || 'Failed');
        })
        .catch(function(err) {
            if (btn) {
                btn.disabled = false;
                btn.textContent = 'Create';
            }
            renderStatus('error', 'Sender ID', err && err.message ? err.message : 'Failed');
        });
}

function renderSpecialDays(listItems) {
    var select = document.getElementById('specialSender');
    if (!select) return;
    var items = Array.isArray(listItems) ? listItems : [];
    if (items.length === 0) {
        select.innerHTML = '<option value="">No Special Day IDs</option>';
        return;
    }
    select.innerHTML = items.map(function(n) {
        return '<option value="' + escapeHtml(String(n)) + '">' + escapeHtml(String(n)) + '</option>';
    }).join('');
}

function renderSpecialDayDatalist(listItems) {
    var dl = document.getElementById('specialDayIds');
    if (!dl) return;
    var items = Array.isArray(listItems) ? listItems : [];
    dl.innerHTML = items.map(function(n) {
        return '<option value="' + escapeHtml(String(n)) + '"></option>';
    }).join('');
}

function sendSpecialSMS() {
    var senderEl = document.getElementById('specialSender');
    var messageEl = document.getElementById('specialMessage');
    var phoneEl = document.getElementById('specialRecipientPhone');
    var btn = document.getElementById('specialSendBtn');
    var statusEl = document.getElementById('specialStatusBox');

    var senderId = senderEl ? senderEl.value : '';
    var message = messageEl ? messageEl.value.trim() : '';
    var recipientPhone = phoneEl ? phoneEl.value.trim() : '';

    if (!senderId || !message || !recipientPhone) {
        renderStatusInto(statusEl, 'error', 'Fill all fields', 'Choose Sender ID, enter message and phone number.');
        return;
    }

    if (btn) {
        btn.disabled = true;
        btn.textContent = 'Sending...';
    }
    renderStatusInto(statusEl, 'success', 'Sending...', 'Please wait.');

    fetchJson('/api/send-sms-special', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ senderId: senderId, message: message, recipientPhone: recipientPhone })
    })
        .then(function(res) {
            if (btn) {
                btn.disabled = false;
                btn.textContent = 'Send';
            }
            if (res.status === 'success') {
                if (Object.prototype.hasOwnProperty.call(res, 'sms_balance')) {
                    if (CURRENT_SESSION && !CURRENT_SESSION.is_admin && !CURRENT_SESSION.is_free) {
                        CURRENT_SESSION.sms_credits = res.sms_balance;
                        renderSmsBalanceBadge(CURRENT_SESSION);
                    }
                }
                if (Object.prototype.hasOwnProperty.call(res, 'sent') || Object.prototype.hasOwnProperty.call(res, 'failed') || Object.prototype.hasOwnProperty.call(res, 'partial') || Object.prototype.hasOwnProperty.call(res, 'results')) {
                    renderBulkSendStatusInto(statusEl, senderId, message, recipientPhone, res, { sms_balance: res.sms_balance });
                } else {
                    var meta = 'From: ' + senderId + '\nTo: ' + recipientPhone + '\nMessage: ' + message;
                    if (Object.prototype.hasOwnProperty.call(res, 'sms_balance')) {
                        meta += '\nSMS balance: ' + String(res.sms_balance || 0);
                    }
                    renderStatusInto(statusEl, 'success', 'SMS sent successfully', meta);
                }
                return;
            }
            if (res && Object.prototype.hasOwnProperty.call(res, 'results')) {
                renderBulkSendStatusInto(statusEl, senderId, message, recipientPhone, res, { sms_balance: res.sms_balance });
                return;
            }
            renderStatusInto(statusEl, 'error', 'Failed to send SMS', res.message || 'Unknown error');
        })
        .catch(function(err) {
            if (btn) {
                btn.disabled = false;
                btn.textContent = 'Send';
            }
            renderStatusInto(statusEl, 'error', 'Error', err && err.message ? err.message : 'An error occurred.');
        });
}

function formatDate(isoStr) {
    if (!isoStr) return '';
    try {
        var d = new Date(isoStr);
        if (isNaN(d.getTime())) return isoStr;
        return d.toLocaleDateString() + ' ' + d.toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'});
    } catch (e) {
        return isoStr;
    }
}

var BRAND_TAB_KEY = 'brand_tab';

function getBrandTab() {
    var v = (sessionStorage.getItem(BRAND_TAB_KEY) || '').toLowerCase();
    if (v === 'verified' || v === 'dashboard' || v === 'trusted' || v === 'special' || v === 'pending' || v === 'free') return v;
    return 'pending';
}

function setBrandTab(tab) {
    var t = String(tab || '').toLowerCase();
    if (t !== 'pending' && t !== 'verified' && t !== 'dashboard' && t !== 'trusted' && t !== 'special' && t !== 'free') t = 'pending';
    sessionStorage.setItem(BRAND_TAB_KEY, t);

    var pendingPanel = document.getElementById('brandTabPending');
    var verifiedPanel = document.getElementById('brandTabVerified');
    var dashboardPanel = document.getElementById('brandTabDashboard');
    var trustedPanel = document.getElementById('brandTabTrusted');
    var specialPanel = document.getElementById('brandTabSpecial');
    var freePanel = document.getElementById('brandTabFree');

    if (pendingPanel) pendingPanel.style.display = (t === 'pending') ? '' : 'none';
    if (verifiedPanel) verifiedPanel.style.display = (t === 'verified') ? '' : 'none';
    if (dashboardPanel) dashboardPanel.style.display = (t === 'dashboard') ? '' : 'none';
    if (trustedPanel) trustedPanel.style.display = (t === 'trusted') ? '' : 'none';
    if (specialPanel) specialPanel.style.display = (t === 'special') ? '' : 'none';
    if (freePanel) freePanel.style.display = (t === 'free') ? '' : 'none';

    var btns = document.querySelectorAll('.js-brand-tab');
    for (var i = 0; i < btns.length; i++) {
        var b = btns[i];
        if (!b) continue;
        var bt = String(b.getAttribute('data-tab') || '').toLowerCase();
        if (bt === t) b.classList.add('active');
        else b.classList.remove('active');
    }

    if (t === 'dashboard') {
        refreshAdminDashboard(_adminStatsDays);
        return;
    }
    if (t === 'trusted') {
        loadTrustedBrands().then(function() {
            var ta = document.getElementById('adminTrustedBrandsText');
            if (ta) { ta.value = trustedBrandsToText(TRUSTED_BRANDS || []); autoGrowTextarea(ta); }
        });
        return;
    }
    if (t === 'special') {
        refreshSpecialDayList();
    } else if (t === 'free') {
        refreshFreeUsers();
    } else {
        refreshPendingSenderIds();
    }
}

function refreshFreeUsers() {
    var box = document.getElementById('freeUsersList');
    if (!box) return;
    var statusEl = document.getElementById('freeUsersStatus');
    if (statusEl) statusEl.innerHTML = '';
    box.textContent = 'Loading...';
    fetchJson('/api/admin/free-users', { method: 'GET' })
        .then(function(res) {
            if (res.status !== 'success') {
                box.textContent = '';
                renderStatusInto(statusEl, 'error', 'Free Users', res.message || 'Failed');
                return;
            }
            var items = Array.isArray(res.free_users) ? res.free_users : [];
            if (!items.length) {
                box.textContent = 'No free users';
                return;
            }
            box.innerHTML = items.map(function(u) {
                var meta = (u.name ? ('Name: ' + u.name + ' • ') : '') + 'Phone: ' + (u.username || '') + (u.brandname ? (' • Brandname: ' + u.brandname) : '');
                return (
                    '<div class="pill-row">' +
                        '<div class="pill-left">' +
                            '<div class="pill-name">' + escapeHtml(u.username || '') + '</div>' +
                            '<div class="pill-status">' + escapeHtml(meta) + '</div>' +
                        '</div>' +
                        '<button class="mini-button danger js-remove-free" data-username="' + escapeHtml(u.username || '') + '">Remove</button>' +
                    '</div>'
                );
            }).join('');
        })
        .catch(function(err) {
            box.textContent = err && err.message ? err.message : 'Failed';
        });
}

function addFreeUserFromInput() {
    var input = document.getElementById('freeUserPhone');
    var btn = document.getElementById('addFreeUserBtn');
    var statusEl = document.getElementById('freeUsersStatus');
    var username = input ? input.value.trim() : '';
    if (!username) {
        renderStatusInto(statusEl, 'error', 'Free Users', 'Enter the user phone/username.');
        return;
    }
    if (btn) { btn.disabled = true; btn.textContent = 'Adding...'; }
    if (statusEl) renderStatusInto(statusEl, 'success', 'Free Users', 'Adding ' + username + '...');
    fetchJson('/api/admin/users/set-free', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: username, is_free: true })
    })
        .then(function(res) {
            if (res.status === 'success') {
                if (input) input.value = '';
                renderStatusInto(statusEl, 'success', 'Free Users', username + ' is now free.');
                refreshFreeUsers();
                refreshUsers();
                return;
            }
            renderStatusInto(statusEl, 'error', 'Free Users', res.message || 'Failed to add free user.');
        })
        .catch(function(err) {
            renderStatusInto(statusEl, 'error', 'Free Users', err && err.message ? err.message : 'Failed to add free user.');
        })
        .finally(function() {
            if (btn) { btn.disabled = false; btn.textContent = 'Add'; }
        });
}

function refreshPendingSenderIds() {
    var box = document.getElementById('pendingSenderIds');
    if (!box) return;
    var approvedBox = document.getElementById('approvedSenderIds');
    box.textContent = 'Loading...';
    if (approvedBox) approvedBox.textContent = 'Loading...';
    fetchJson('/api/admin/sender-ids', { method: 'GET' })
        .then(function(res) {
            if (res.status !== 'success') {
                box.textContent = 'Failed';
                if (approvedBox) approvedBox.textContent = 'Failed';
                return;
            }
            var pending = Array.isArray(res.pending) ? res.pending : [];
            if (!pending.length) {
                box.textContent = 'No pending Sender IDs';
            } else {
                box.innerHTML = pending.map(function(p) {
                    var meta = 'User: ' + String(p.username || '');
                    var when = formatDate(p.created_at);
                    if (when) meta += ' • Requested: ' + when;
                    return (
                        '<div class="pill-row">' +
                            '<div class="pill-left">' +
                                '<div class="pill-name">' + escapeHtml(p.name || '') + '</div>' +
                                '<div class="pill-status">' + escapeHtml(meta) + '</div>' +
                            '</div>' +
                            '<div class="user-actions">' +
                                '<button class="mini-button js-approve-sender" data-username="' + escapeHtml(p.username || '') + '" data-name="' + escapeHtml(p.name || '') + '">Approve</button>' +
                                '<button class="mini-button danger js-delete-sender" data-username="' + escapeHtml(p.username || '') + '" data-name="' + escapeHtml(p.name || '') + '">Delete</button>' +
                            '</div>' +
                        '</div>'
                    );
                }).join('');
            }

            if (approvedBox) {
                var approved = Array.isArray(res.approved) ? res.approved : [];
                if (!approved.length) {
                    approvedBox.textContent = 'No verified Sender IDs';
                } else {
                    approvedBox.innerHTML = approved.map(function(a) {
                        var meta = 'User: ' + String(a.username || '');
                        var when = formatDate(a.approved_at);
                        if (when) meta += ' • Approved: ' + when;
                        return (
                            '<div class="pill-row">' +
                                '<div class="pill-left">' +
                                    '<div class="pill-name">' + escapeHtml(a.name || '') + '</div>' +
                                    '<div class="pill-status">' + escapeHtml(meta) + '</div>' +
                                '</div>' +
                                '<button class="mini-button danger js-delete-sender" data-username="' + escapeHtml(a.username || '') + '" data-name="' + escapeHtml(a.name || '') + '">Delete</button>' +
                            '</div>'
                        );
                    }).join('');
                }
            }
        })
        .catch(function(err) {
            box.textContent = err && err.message ? err.message : 'Failed';
            if (approvedBox) approvedBox.textContent = err && err.message ? err.message : 'Failed';
        });
}

function approveSenderId(username, name) {
    fetchJson('/api/admin/sender-ids/approve', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: username, name: name })
    })
        .then(function(res) {
            if (res.status === 'success') {
                renderStatus('success', 'Approved', name);
                fetchSession().then(function(s) { showMode(currentMode(), s); });
                return;
            }
            renderStatus('error', 'Approve failed', res.message || 'Failed');
        })
        .catch(function(err) {
            renderStatus('error', 'Approve failed', err && err.message ? err.message : 'Failed');
        });
}

function deletePendingSenderId(username, name) {
    fetchJson('/api/admin/sender-ids/delete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: username, name: name })
    })
        .then(function(res) {
            if (res.status === 'success') {
                renderStatus('success', 'Deleted', name);
                fetchSession().then(function(s) { showMode(currentMode(), s); });
                return;
            }
            renderStatus('error', 'Delete failed', res.message || 'Failed');
        })
        .catch(function(err) {
            renderStatus('error', 'Delete failed', err && err.message ? err.message : 'Failed');
        });
}

function refreshSpecialDayList() {
    var box = document.getElementById('specialDayList');
    if (!box) return;
    box.textContent = 'Loading...';
    fetchJson('/api/admin/special-days', { method: 'GET' })
        .then(function(res) {
            if (res.status !== 'success') {
                box.textContent = 'Failed';
                return;
            }
            var items = Array.isArray(res.special_day_sender_ids) ? res.special_day_sender_ids : [];
            if (items.length === 0) {
                box.textContent = 'No Special Day IDs';
                return;
            }
            box.innerHTML = items.map(function(n) {
                return (
                    '<div class="pill-row">' +
                        '<div class="pill-left"><div class="pill-name">' + escapeHtml(String(n)) + '</div></div>' +
                        '<button class="mini-button danger js-del-special" data-name="' + escapeHtml(String(n)) + '">Delete</button>' +
                    '</div>'
                );
            }).join('');
        })
        .catch(function(err) {
            box.textContent = err && err.message ? err.message : 'Failed';
        });
}

function addSpecialDayId() {
    var input = document.getElementById('newSpecialDayId');
    var btn = document.getElementById('addSpecialDayBtn');
    var name = input ? input.value.trim() : '';
    if (!name) return;
    if (btn) {
        btn.disabled = true;
        btn.textContent = 'Adding...';
    }
    fetchJson('/api/admin/special-days/add', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: name })
    })
        .then(function(res) {
            if (btn) {
                btn.disabled = false;
                btn.textContent = 'Add';
            }
            if (res.status === 'success') {
                if (input) input.value = '';
                fetchSession().then(function(s) { showMode(currentMode(), s); });
                return;
            }
            renderStatus('error', 'Special Day', res.message || 'Failed');
        })
        .catch(function(err) {
            if (btn) {
                btn.disabled = false;
                btn.textContent = 'Add';
            }
            renderStatus('error', 'Special Day', err && err.message ? err.message : 'Failed');
        });
}

function deleteSpecialDayId(name) {
    fetchJson('/api/admin/special-days/delete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: name })
    })
        .then(function(res) {
            if (res.status === 'success') {
                fetchSession().then(function(s) { showMode(currentMode(), s); });
                return;
            }
            renderStatus('error', 'Special Day', res.message || 'Failed');
        })
        .catch(function(err) {
            renderStatus('error', 'Special Day', err && err.message ? err.message : 'Failed');
        });
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
                var namePart = (u.name || '').trim() ? ('Name: ' + (u.name || '') + ' • ') : '';
                var planPart = u.is_free ? 'Free account • ' : '';
                var line2 = namePart + planPart + 'Brandname: ' + (u.brandname || '') + (u.disabled ? ' • Disabled' : ' • Active');
                var actions = '';
                var passLabel = u.is_admin ? 'Change Password' : 'Reset Password';
                if (u.is_admin) {
                    actions =
                        '<div class="user-actions">' +
                            '<button class="mini-button js-reset-pass" data-username="' + escapeHtml(u.username || '') + '">' + passLabel + '</button>' +
                        '</div>';
                } else {
                    actions =
                        '<div class="user-actions">' +
                            '<button class="mini-button js-toggle-free" data-username="' + escapeHtml(u.username || '') + '" data-is_free="' + (u.is_free ? '0' : '1') + '">' + (u.is_free ? 'Remove Free' : 'Set Free') + '</button>' +
                            '<button class="mini-button js-toggle-user" data-username="' + escapeHtml(u.username || '') + '" data-disabled="' + (u.disabled ? '0' : '1') + '">' + (u.disabled ? 'Enable' : 'Disable') + '</button>' +
                            '<button class="mini-button js-reset-pass" data-username="' + escapeHtml(u.username || '') + '">' + passLabel + '</button>' +
                            '<button class="mini-button js-change-brand" data-username="' + escapeHtml(u.username || '') + '">Change Brand</button>' +
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

function changeUserBrandname(username) {
    if (!username) return;
    var newBrand = window.prompt('Enter new brandname for ' + username);
    if (!newBrand) return;
    fetchJson('/api/admin/users/update-brandname', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: username, brandname: newBrand })
    })
        .then(function(res) {
            if (res.status === 'success') {
                renderStatus('success', 'Brandname updated', 'User: ' + username + '\nBrandname: ' + newBrand);
                refreshUsers();
                return;
            }
            renderStatus('error', 'Failed', res.message || 'Could not update brandname');
        })
        .catch(function(err) {
            renderStatus('error', 'Error', err && err.message ? err.message : 'Could not update brandname');
        });
}

function toggleUserFree(username, isFree) {
    if (!username) return;
    fetchJson('/api/admin/users/set-free', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: username, is_free: !!isFree })
    })
        .then(function(res) {
            if (res.status === 'success') {
                renderStatus('success', 'Updated', username + (isFree ? ' set to free' : ' set to normal'));
                refreshUsers();
                return;
            }
            renderStatus('error', 'Failed', res.message || 'Could not update user');
        })
        .catch(function(err) {
            renderStatus('error', 'Error', err && err.message ? err.message : 'Could not update user');
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
        var source = t.source || 'user';
        var canDelete = !!t.can_delete;
        var title = (t.title || '').trim() || (text.split('\n')[0] || text);
        if (title.length > 18) title = title.slice(0, 18) + '...';
        return (
            '<div class="flip-box">' +
                '<div class="flip-box-inner">' +
                    '<div class="flip-box-front js-use-template-front" data-text="' + escapeHtml(text) + '">' +
                        '<h2>' + escapeHtml(title || 'Template') + '</h2>' +
                    '</div>' +
                    '<div class="flip-box-back">' +
                        '<h4>' + escapeHtml(text) + '</h4>' +
                        '<button class="use-template-button js-use-template" data-text="' + escapeHtml(text) + '">Use Template</button>' +
                        (canDelete ? '<button class="delete-template-button js-delete-template" data-id="' + escapeHtml(id) + '">Delete</button>' : '') +
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

function setAdminTemplateStatus(text) {
    var el = document.getElementById('adminTemplateStatus');
    if (!el) return;
    el.textContent = String(text || '');
}

function addAdminTemplate() {
    if (!CURRENT_SESSION || !CURRENT_SESSION.is_admin) return;
    var idEl = document.getElementById('adminTemplateId');
    var textEl = document.getElementById('adminTemplateText');
    var btn = document.getElementById('addAdminTemplateBtn');
    var id = idEl ? idEl.value.trim() : '';
    var text = textEl ? textEl.value.trim() : '';
    if (!id || !text) {
        setAdminTemplateStatus('Enter template ID and message.');
        return;
    }
    if (btn) {
        btn.disabled = true;
        btn.textContent = 'Adding...';
    }
    fetchJson('/api/admin/templates/add', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: id, text: text })
    })
        .then(function(res) {
            if (btn) {
                btn.disabled = false;
                btn.textContent = 'Add Template';
            }
            if (res.status === 'success') {
                if (idEl) idEl.value = '';
                if (textEl) textEl.value = '';
                setAdminTemplateStatus('Added');
                loadTemplates();
                return;
            }
            setAdminTemplateStatus(res.message || 'Failed to add');
        })
        .catch(function(err) {
            if (btn) {
                btn.disabled = false;
                btn.textContent = 'Add Template';
            }
            setAdminTemplateStatus(err && err.message ? err.message : 'Failed to add');
        });
}

document.addEventListener('DOMContentLoaded', function() {
    dedupeElementsById('brandnamesBox');
    dedupeElementsById('pendingSenderIds');
    dedupeElementsById('approvedSenderIds');
    dedupeElementsById('specialDayList');
    dedupeElementsById('newSpecialDayId');
    dedupeElementsById('addSpecialDayBtn');
    dedupeElementsById('freeUsersList');
    dedupeElementsById('freeUsersStatus');
    dedupeElementsById('adminAdsBanner');
    dedupeElementsById('adminAdsKicker');
    dedupeElementsById('adminAdsTyping');
    dedupeElementsById('freeUserPhone');
    dedupeElementsById('addFreeUserBtn');
    dedupeElementsById('adminHomeAdsText');
    dedupeElementsById('saveHomeAdsBtn');
    dedupeElementsById('adminHomeAdsStatus');
    dedupeElementsById('adminHomePreviewText');
    dedupeElementsById('saveHomePreviewBtn');
    dedupeElementsById('adminHomePreviewStatus');
    dedupeElementsById('adminSpecialAdsText');
    dedupeElementsById('saveSpecialAdsBtn');
    dedupeElementsById('adminSpecialAdsStatus');
    dedupeElementsById('adminSpecialPreviewText');
    dedupeElementsById('saveSpecialPreviewBtn');
    dedupeElementsById('adminSpecialPreviewStatus');
    dedupeElementsById('adminTrustedBrandsText');
    dedupeElementsById('saveTrustedBrandsBtn');
    dedupeElementsById('clearTrustedBrandsBtn');
    dedupeElementsById('adminTrustedBrandsStatus');
    dedupeElementsById('adminStats7Btn');
    dedupeElementsById('adminStats30Btn');
    dedupeElementsById('adminStatsAllBtn');
    dedupeElementsById('adminStatsStatus');
    dedupeElementsById('adminStatsChart');
    dedupeElementsById('adminCurrentPassword');
    dedupeElementsById('adminNewPassword');
    dedupeElementsById('adminNewPassword2');
    dedupeElementsById('adminChangePasswordBtn');
    dedupeElementsById('adminChangePasswordStatus');

    var mode = currentMode();

    function modeForHref(href) {
        var raw = String(href || '');
        if (!raw) return null;
        if (raw.indexOf('javascript:') === 0 || raw.indexOf('#') === 0) return null;
        try {
            var u = new URL(raw, window.location.origin);
            var path = String(u.pathname || '').toLowerCase();
            if (!(path.endsWith('/index.html') || path.endsWith('index.html') || path === '/' || path === '')) return null;
            if (u.searchParams.has('mode')) return String(u.searchParams.get('mode') || '').toLowerCase();
            return '';
        } catch (e) {
            return null;
        }
    }

    function navigateMode(nextMode) {
        var m = String(nextMode || '').toLowerCase();
        try {
            var url = new URL(window.location.href);
            if (m) url.searchParams.set('mode', m);
            else url.searchParams.delete('mode');
            if (window.history && window.history.pushState) {
                window.history.pushState({ mode: m }, '', url.pathname + url.search);
            }
        } catch (e1) {}

        if (!CURRENT_SESSION) {
            fetchSession().then(function(s) {
                showMode(m, s);
                if (s && s.logged_in) {
                    applyAdsForMode(m === 'special' ? 'special' : 'home');
                }
            });
            return;
        }

        showMode(m, CURRENT_SESSION);
        if (CURRENT_SESSION && CURRENT_SESSION.logged_in) {
            applyAdsForMode(m === 'special' ? 'special' : 'home');
        }
    }

    var topnav = document.getElementById('myTopnav');
    if (topnav) {
        topnav.addEventListener('click', function(e) {
            var t = e && e.target ? e.target : null;
            if (!t) return;
            if (t.tagName && String(t.tagName).toLowerCase() !== 'a' && t.closest) t = t.closest('a');
            if (!t || !t.getAttribute) return;

            if (t.classList && t.classList.contains('icon')) {
                return;
            }

            var isResponsive = (' ' + String(topnav.className || '') + ' ').indexOf(' responsive ') !== -1;
            if (isResponsive) topnav.className = 'topnav';
        });
    }

    try {
        window.addEventListener('popstate', function() {
            var m = currentMode();
            if (!CURRENT_SESSION) {
                fetchSession().then(function(s) {
                    showMode(m, s);
                    if (s && s.logged_in) {
                        applyAdsForMode(m === 'special' ? 'special' : 'home');
                    }
                });
                return;
            }
            showMode(m, CURRENT_SESSION);
            if (CURRENT_SESSION && CURRENT_SESSION.logged_in) {
                applyAdsForMode(m === 'special' ? 'special' : 'home');
            }
        });
    } catch (e2) {}

    var pwToggles = document.querySelectorAll('.pw-toggle');
    if (pwToggles && pwToggles.forEach) {
        pwToggles.forEach(function(btn) {
            btn.addEventListener('click', function() {
                var targetId = btn.getAttribute('data-target') || '';
                if (!targetId) return;
                var input = document.getElementById(targetId);
                if (!input) return;
                var isHidden = String(input.getAttribute('type') || '').toLowerCase() === 'password';
                input.setAttribute('type', isHidden ? 'text' : 'password');
                btn.setAttribute('aria-label', isHidden ? 'Hide password' : 'Show password');
                var icon = btn.querySelector('i');
                if (icon) {
                    icon.className = isHidden ? 'fa fa-eye-slash' : 'fa fa-eye';
                    icon.setAttribute('aria-hidden', 'true');
                }
            });
        });
    }

    function bindDigitsOnly(id) {
        var el = document.getElementById(id);
        if (!el) return;
        el.addEventListener('input', function() {
            var v = String(el.value || '');
            var nv = v.replace(/\D+/g, '');
            if (v !== nv) el.value = nv;
        });
    }

    function normalizePhoneNumberClient(raw) {
        var s = String(raw || '').trim();
        if (!s) return '';
        s = s.replace(/[\u200B-\u200F\u202A-\u202E]/g, '');
        s = s.replace(/[ \t\r\n\-\(\)]/g, '');
        if (s.charAt(0) === '+') s = s.slice(1);
        s = s.replace(/\D+/g, '');
        if (s.charAt(0) === '0' && s.length === 10 && /^\d+$/.test(s)) {
            s = '233' + s.slice(1);
        }
        return s;
    }

    function cleanRecipientsText(raw) {
        var src = String(raw || '');
        var candidates = [];
        var re = /(\+?\d[\d\s\-\(\)]{6,}\d)/g;
        var m = null;
        while ((m = re.exec(src)) !== null) {
            candidates.push(String(m[1] || ''));
        }
        if (!candidates.length) {
            var parts = src.replace(/[,;\n\r]+/g, ' ').split(/\s+/).filter(Boolean);
            for (var i = 0; i < parts.length; i++) {
                if (/\d/.test(parts[i])) candidates.push(parts[i]);
            }
        }

        var seen = {};
        var valid = [];
        var invalid = [];
        var duplicatesRemoved = 0;

        for (var j = 0; j < candidates.length; j++) {
            var n = normalizePhoneNumberClient(candidates[j]);
            if (!n) continue;
            if (!/^\d+$/.test(n) || n.length < 8 || n.length > 15) {
                invalid.push(n);
                continue;
            }
            if (seen[n]) {
                duplicatesRemoved += 1;
                continue;
            }
            seen[n] = true;
            valid.push(n);
        }

        return { valid: valid, invalid: invalid, duplicatesRemoved: duplicatesRemoved };
    }

    function bindRecipientsCleaner(textareaId, statusId) {
        var el = document.getElementById(textareaId);
        if (!el) return;
        var statusEl = document.getElementById(statusId);
        var applying = false;

        function updateStatus(raw, res) {
            if (!statusEl) return;
            var msg = 'Recipients: ' + res.valid.length;
            if (res.duplicatesRemoved) msg += ' | Duplicates removed: ' + res.duplicatesRemoved;
            if (res.invalid.length) {
                msg += ' | Invalid: ' + res.invalid.length;
                var preview = res.invalid.slice(0, 10).join(', ');
                if (preview) msg += ' — ' + preview + (res.invalid.length > 10 ? ' ...' : '');
            }
            statusEl.textContent = msg;
        }

        function refreshStatusOnly() {
            if (applying) return;
            applying = true;
            var raw = String(el.value || '');
            var res = cleanRecipientsText(raw);
            updateStatus(raw, res);
            applying = false;
        }

        function normalizeNow() {
            if (applying) return;
            applying = true;
            var raw = String(el.value || '');
            var res = cleanRecipientsText(raw);
            var cleaned = res.valid.join(', ');
            if (raw !== cleaned) el.value = cleaned;
            updateStatus(cleaned, res);
            applying = false;
        }

        el.addEventListener('input', refreshStatusOnly);
        el.addEventListener('blur', normalizeNow);
        el.addEventListener('paste', function() { setTimeout(normalizeNow, 0); });
        refreshStatusOnly();
    }

    bindDigitsOnly('loginUsername');
    bindDigitsOnly('signupPhone');
    bindDigitsOnly('resetPhone');
    bindDigitsOnly('newUsername');
    bindDigitsOnly('freeUserPhone');
    bindRecipientsCleaner('recipientPhone', 'recipientPhoneStatus');
    bindRecipientsCleaner('specialRecipientPhone', 'specialRecipientPhoneStatus');

    var messageInput = document.getElementById('Message1');
    if (messageInput) {
        messageInput.addEventListener('input', updatePreviewMessage);
        messageInput.addEventListener('input', function() { autoGrowTextarea(messageInput); });
    }

    var recipientInput = document.getElementById('recipientPhone');
    if (recipientInput) {
        recipientInput.addEventListener('input', function() { autoGrowTextarea(recipientInput); });
    }

    var specialMessage = document.getElementById('specialMessage');
    if (specialMessage) {
        specialMessage.addEventListener('input', updatePreviewMessage);
        specialMessage.addEventListener('input', function() { autoGrowTextarea(specialMessage); });
        autoGrowTextarea(specialMessage);
    }
    var specialPhone = document.getElementById('specialRecipientPhone');
    if (specialPhone) {
        specialPhone.addEventListener('input', function() { autoGrowTextarea(specialPhone); });
        autoGrowTextarea(specialPhone);
    }

    var adminTemplateText = document.getElementById('adminTemplateText');
    if (adminTemplateText) {
        adminTemplateText.addEventListener('input', function() { autoGrowTextarea(adminTemplateText); });
        autoGrowTextarea(adminTemplateText);
    }

    var adminHomeAdsText = document.getElementById('adminHomeAdsText');
    if (adminHomeAdsText) {
        adminHomeAdsText.addEventListener('input', function() { autoGrowTextarea(adminHomeAdsText); });
        autoGrowTextarea(adminHomeAdsText);
    }
    var adminSpecialAdsText = document.getElementById('adminSpecialAdsText');
    if (adminSpecialAdsText) {
        adminSpecialAdsText.addEventListener('input', function() { autoGrowTextarea(adminSpecialAdsText); });
        autoGrowTextarea(adminSpecialAdsText);
    }
    var adminHomePreviewText = document.getElementById('adminHomePreviewText');
    if (adminHomePreviewText) {
        adminHomePreviewText.addEventListener('input', function() { autoGrowTextarea(adminHomePreviewText); });
        autoGrowTextarea(adminHomePreviewText);
    }
    var adminSpecialPreviewText = document.getElementById('adminSpecialPreviewText');
    if (adminSpecialPreviewText) {
        adminSpecialPreviewText.addEventListener('input', function() { autoGrowTextarea(adminSpecialPreviewText); });
        autoGrowTextarea(adminSpecialPreviewText);
    }
    var adminTrustedBrandsText = document.getElementById('adminTrustedBrandsText');
    if (adminTrustedBrandsText) {
        adminTrustedBrandsText.addEventListener('input', function() { autoGrowTextarea(adminTrustedBrandsText); });
        autoGrowTextarea(adminTrustedBrandsText);
    }

    var saveHomeAdsBtn = document.getElementById('saveHomeAdsBtn');
    if (saveHomeAdsBtn) saveHomeAdsBtn.addEventListener('click', saveHomeAds);
    var saveSpecialAdsBtn = document.getElementById('saveSpecialAdsBtn');
    if (saveSpecialAdsBtn) saveSpecialAdsBtn.addEventListener('click', saveSpecialAds);
    var saveHomePreviewBtn = document.getElementById('saveHomePreviewBtn');
    if (saveHomePreviewBtn) saveHomePreviewBtn.addEventListener('click', saveHomePreview);
    var saveSpecialPreviewBtn = document.getElementById('saveSpecialPreviewBtn');
    if (saveSpecialPreviewBtn) saveSpecialPreviewBtn.addEventListener('click', saveSpecialPreview);
    var saveTrustedBrandsBtn = document.getElementById('saveTrustedBrandsBtn');
    if (saveTrustedBrandsBtn) saveTrustedBrandsBtn.addEventListener('click', saveTrustedBrands);
    var clearTrustedBrandsBtn = document.getElementById('clearTrustedBrandsBtn');
    if (clearTrustedBrandsBtn) clearTrustedBrandsBtn.addEventListener('click', clearTrustedBrands);
    var adminStats7Btn = document.getElementById('adminStats7Btn');
    if (adminStats7Btn) adminStats7Btn.addEventListener('click', function() { refreshAdminDashboard(7); });
    var adminStats30Btn = document.getElementById('adminStats30Btn');
    if (adminStats30Btn) adminStats30Btn.addEventListener('click', function() { refreshAdminDashboard(30); });
    var adminStatsAllBtn = document.getElementById('adminStatsAllBtn');
    if (adminStatsAllBtn) adminStatsAllBtn.addEventListener('click', function() { refreshAdminDashboard(0); });
    var adminChangePasswordBtn = document.getElementById('adminChangePasswordBtn');
    if (adminChangePasswordBtn) adminChangePasswordBtn.addEventListener('click', adminChangePassword);

    var usersList = document.getElementById('usersList');
    if (usersList) {
        usersList.addEventListener('click', function(e) {
            var t = e.target;
            if (!t) return;
            if (t.classList && t.classList.contains('js-toggle-free')) {
                var username0 = t.getAttribute('data-username') || '';
                var makeFree = t.getAttribute('data-is_free') === '1';
                toggleUserFree(username0, makeFree);
                return;
            }
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
            if (t.classList && t.classList.contains('js-change-brand')) {
                var username3 = t.getAttribute('data-username') || '';
                changeUserBrandname(username3);
                return;
            }
        });
    }

    var brandnamesBox = document.getElementById('brandnamesBox');
    if (brandnamesBox) {
        brandnamesBox.addEventListener('click', function(e) {
            var t = e.target;
            if (!t) return;
            if (t.classList && t.classList.contains('js-brand-tab')) {
                var tab = t.getAttribute('data-tab') || 'pending';
                setBrandTab(tab);
                return;
            }
            if (t && t.id === 'addFreeUserBtn') {
                addFreeUserFromInput();
                return;
            }
            if (t.classList && t.classList.contains('js-remove-free')) {
                var u0 = t.getAttribute('data-username') || '';
                var statusEl = document.getElementById('freeUsersStatus');
                if (statusEl) renderStatusInto(statusEl, 'success', 'Free Users', 'Removing ' + u0 + '...');
                fetchJson('/api/admin/users/set-free', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ username: u0, is_free: false })
                })
                    .then(function(res) {
                        if (res.status === 'success') {
                            if (statusEl) renderStatusInto(statusEl, 'success', 'Free Users', u0 + ' removed from free users.');
                            refreshFreeUsers();
                            refreshUsers();
                            return;
                        }
                        if (statusEl) renderStatusInto(statusEl, 'error', 'Free Users', res.message || 'Failed to remove.');
                    })
                    .catch(function(err) {
                        if (statusEl) renderStatusInto(statusEl, 'error', 'Free Users', err && err.message ? err.message : 'Failed to remove.');
                    });
                return;
            }
            if (t.classList && t.classList.contains('js-approve-sender')) {
                var u = t.getAttribute('data-username') || '';
                var n = t.getAttribute('data-name') || '';
                approveSenderId(u, n);
                return;
            }
            if (t.classList && t.classList.contains('js-delete-sender')) {
                var u2 = t.getAttribute('data-username') || '';
                var n2 = t.getAttribute('data-name') || '';
                deletePendingSenderId(u2, n2);
                return;
            }
            if (t.classList && t.classList.contains('js-del-special')) {
                var n3 = t.getAttribute('data-name') || '';
                deleteSpecialDayId(n3);
                return;
            }
        });
    }

    fetchSession().then(function(session) {
        var activeMode = currentMode();
        showMode(activeMode, session);
        Promise.all([loadAds(), loadTrustedBrands()]).then(function() {
            if (session && session.logged_in) {
                applyAdsForMode(activeMode === 'special' ? 'special' : 'home');
            }
            if (session && session.is_admin) {
                var t1 = document.getElementById('adminHomeAdsText');
                if (t1) { t1.value = (HOME_ADS || []).join('\n'); autoGrowTextarea(t1); }
                var t2 = document.getElementById('adminSpecialAdsText');
                if (t2) { t2.value = (SPECIAL_ADS || []).join('\n'); autoGrowTextarea(t2); }
                var t3 = document.getElementById('adminHomePreviewText');
                if (t3) { t3.value = String(HOME_PREVIEW_MESSAGE || ''); autoGrowTextarea(t3); }
                var t4 = document.getElementById('adminSpecialPreviewText');
                if (t4) { t4.value = String(SPECIAL_PREVIEW_MESSAGE || ''); autoGrowTextarea(t4); }
                var t5 = document.getElementById('adminTrustedBrandsText');
                if (t5) { t5.value = trustedBrandsToText(TRUSTED_BRANDS || []); autoGrowTextarea(t5); }
            }
            updatePreviewMessage();
        });
        if (activeMode === 'subscription') {
            var params = new URLSearchParams(window.location.search || '');
            var ref = params.get('reference') || params.get('trxref') || '';
            if (ref) verifyPaystackReference(ref);
        }

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
                var front = null;
                if (t.closest) {
                    front = t.closest('.js-use-template-front');
                } else if (t.classList && t.classList.contains('js-use-template-front')) {
                    front = t;
                } else if (t.parentElement && t.parentElement.classList && t.parentElement.classList.contains('js-use-template-front')) {
                    front = t.parentElement;
                }
                if (front) {
                    var txt0 = front.getAttribute('data-text') || '';
                    useTemplate(txt0);
                    return;
                }
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

    updatePreviewMessage();
    autoGrowTextarea(messageInput);
    autoGrowTextarea(recipientInput);
    renderSubscriptionPlans();

    var plansEl = document.getElementById('subscriptionPlans');
    if (plansEl) {
        plansEl.addEventListener('click', function(e) {
            var t = e.target;
            if (!t) return;
            var sms = t.getAttribute ? t.getAttribute('data-sms') : '';
            if (t.classList && t.classList.contains('js-select-plan')) {
                SELECTED_SUBSCRIPTION_SMS = sms;
                renderSubscriptionPlans();
                return;
            }
            if (t.classList && t.classList.contains('js-buy-plan')) {
                var price = t.getAttribute('data-price') || '';
                var statusEl = document.getElementById('subscriptionStatus');
                t.disabled = true;
                t.textContent = 'Processing...';
                renderStatusInto(statusEl, 'success', 'Opening payment...', 'Please wait.');
                fetchJson('/api/paystack/initialize', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ email: PAYSTACK_FIXED_EMAIL, sms: Number(sms), price: Number(price) })
                })
                    .then(function(res) {
                        if (res.status !== 'success') {
                            renderStatusInto(statusEl, 'error', 'Payment failed', res.message || 'Failed to start payment.');
                            return;
                        }
                        if (res.authorization_url) {
                            window.location.href = res.authorization_url;
                            return;
                        }
                        renderStatusInto(statusEl, 'error', 'Payment failed', 'Missing authorization URL.');
                    })
                    .catch(function(err) {
                        renderStatusInto(statusEl, 'error', 'Payment failed', err && err.message ? err.message : 'Failed to start payment.');
                    })
                    .finally(function() {
                        t.disabled = false;
                        t.textContent = 'Buy';
                    });
            }
        });
    }
});