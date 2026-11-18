/**
 * ============================================================================
 * THU_CHI_HO_MAI - GOOGLE APPS SCRIPT WEBHOOK CONNECTOR (Code.gs)
 * ============================================================================
 * Ho tro ket noi TRUC TIEP tu Web tinh (GitHub Pages) va tu Backend Express.
 * Bao mat:
 * - Mat khau trong tab LOGIN KHONG BAO GIO duoc tra ve qua mang (luon an ••••••••).
 * - Xac thuc Admin bang HMAC-SHA256 Token co chu ky so & khoa 1 gio neu sai 3 lan.
 * - Moi thao tac ghi/sua/xoa/dong bo deu bat buoc co Admin Token hop le.
 *
 * Huong dan trien khai nhanh:
 * 1. Mo Google Sheet "THU CHI QUY HO MAI" cua ban.
 * 2. Vao menu: Tien ich mo rong (Extensions) -> Apps Script.
 * 3. Xoa ma mac dinh va dan toan bo file nay vao Code.gs.
 * 4. Nhan Luu (Ctrl+S), dat ten du an: "THU_CHI_HO_MAI_WEBHOOK".
 * 5. Vao Trien khai (Deploy) -> Trien khai moi (New deployment).
 *    - Loai: Ung dung web (Web app)
 *    - Thuc thi duoi quyen: Toi (Me)
 *    - Ai co quyen truy cap: Bat ky ai (Anyone)
 * 6. Nhan Trien khai, cap quyen truy cap Google Sheet, roi copy URL "/exec".
 * 7. Dan URL "/exec" vao man hinh Thiet lap lan dau tren Web (GitHub Pages / Express).
 * ============================================================================
 */

var DEFAULT_SPREADSHEET_ID = '1gONqBiPvTUsNThDZg6y8nCxmRueiRUsXEm8o5C_rB84';
var CODE_GS_VERSION = '2026.09.github-web';
var MAX_LOGIN_ATTEMPTS = 3;
var LOCKOUT_DURATION_MS = 60 * 60 * 1000; // 1 gio
var DEFAULT_BACKGROUND_URL = '/src/assets/images/ho_mai_backdrop_1794969196398.jpg';

function getSpreadsheet_() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  if (ss) return ss;
  var customId = PropertiesService.getScriptProperties().getProperty('SPREADSHEET_ID') || DEFAULT_SPREADSHEET_ID;
  if (customId) {
    try {
      return SpreadsheetApp.openById(customId);
    } catch (e) {}
  }
  return null;
}

function findSheetCaseInsensitive_(ss, name) {
  var direct = ss.getSheetByName(name);
  if (direct) return direct;
  var all = ss.getSheets();
  var target = String(name || '').toUpperCase().trim();
  for (var i = 0; i < all.length; i++) {
    if (all[i].getName().toUpperCase().trim() === target) return all[i];
  }
  return null;
}

function jsonResponse_(data) {
  return ContentService
    .createTextOutput(JSON.stringify(data))
    .setMimeType(ContentService.MimeType.JSON);
}

function maskLoginSheet_(doc) {
  if (!doc) return doc;
  if (doc.category === 'LOGIN' || String(doc.name || '').toUpperCase() === 'LOGIN') {
    var masked = {};
    for (var k in doc) {
      if (Object.prototype.hasOwnProperty.call(doc, k)) masked[k] = doc[k];
    }
    masked.rows = (doc.rows || []).map(function(r) {
      return {
        id: r.id,
        stt: r.stt,
        name: r.name,
        user: r.user,
        password: '••••••••',
        role: r.role
      };
    });
    return masked;
  }
  return doc;
}

function getSigningKey_() {
  var props = PropertiesService.getScriptProperties();
  var key = props.getProperty('HO_MAI_SIGNING_KEY');
  if (!key || key.length < 32) {
    key = Utilities.getUuid() + '-' + Utilities.getUuid() + '-' + new Date().getTime();
    props.setProperty('HO_MAI_SIGNING_KEY', key);
  }
  return key;
}

function toBase64Url_(bytes) {
  return Utilities.base64EncodeWebSafe(bytes).replace(/=+$/, '');
}

function fromBase64UrlToString_(b64url) {
  var b64 = String(b64url || '').replace(/-/g, '+').replace(/_/g, '/');
  while (b64.length % 4 !== 0) b64 += '=';
  return Utilities.newBlob(Utilities.base64Decode(b64)).getDataAsString('UTF-8');
}

function safeEqualStr_(a, b) {
  var sa = String(a === undefined || a === null ? '' : a);
  var sb = String(b === undefined || b === null ? '' : b);
  var len = Math.max(sa.length, sb.length);
  var diff = sa.length ^ sb.length;
  for (var i = 0; i < len; i++) {
    var ca = i < sa.length ? sa.charCodeAt(i) : 0;
    var cb = i < sb.length ? sb.charCodeAt(i) : 0;
    diff |= (ca ^ cb);
  }
  return diff === 0;
}

function isTokenRevoked_(jti) {
  if (!jti) return false;
  var props = PropertiesService.getScriptProperties();
  var raw = props.getProperty('HO_MAI_REVOKED_TOKENS');
  if (!raw) return false;
  try {
    var map = JSON.parse(raw);
    return Boolean(map[jti] && map[jti] > new Date().getTime());
  } catch (e) {
    return false;
  }
}

function revokeTokenId_(jti, exp) {
  if (!jti) return;
  var props = PropertiesService.getScriptProperties();
  var now = new Date().getTime();
  var map = {};
  try {
    var raw = props.getProperty('HO_MAI_REVOKED_TOKENS');
    if (raw) map = JSON.parse(raw) || {};
  } catch (e) {}
  map[jti] = exp || (now + 30 * 24 * 60 * 60 * 1000);
  var cleaned = {};
  for (var k in map) {
    if (Object.prototype.hasOwnProperty.call(map, k) && map[k] > now) {
      cleaned[k] = map[k];
    }
  }
  props.setProperty('HO_MAI_REVOKED_TOKENS', JSON.stringify(cleaned));
}

function signAdminToken_(user, rememberMe) {
  var now = new Date().getTime();
  var ttl = rememberMe ? (30 * 24 * 60 * 60 * 1000) : (8 * 60 * 60 * 1000);
  var payloadObj = {
    id: user.id,
    name: user.name,
    user: user.user,
    role: 'admin',
    jti: Utilities.getUuid(),
    iat: now,
    exp: now + ttl
  };
  var payloadBytes = Utilities.newBlob(JSON.stringify(payloadObj)).getBytes();
  var payloadB64 = toBase64Url_(payloadBytes);
  var sigBytes = Utilities.computeHmacSha256Signature(payloadB64, getSigningKey_());
  var sigB64 = toBase64Url_(sigBytes);
  return payloadB64 + '.' + sigB64;
}

function verifyAdminToken_(token) {
  if (!token || typeof token !== 'string') return null;
  var parts = token.split('.');
  if (parts.length !== 2) return null;
  var payloadB64 = parts[0];
  var sigB64 = parts[1];
  var expectedBytes = Utilities.computeHmacSha256Signature(payloadB64, getSigningKey_());
  var expectedB64 = toBase64Url_(expectedBytes);
  if (!safeEqualStr_(sigB64, expectedB64)) return null;
  try {
    var decoded = JSON.parse(fromBase64UrlToString_(payloadB64));
    if (!decoded || typeof decoded.exp !== 'number' || new Date().getTime() > decoded.exp) {
      return null;
    }
    if (decoded.role !== 'admin') return null;
    if (isTokenRevoked_(decoded.jti)) return null;
    return {
      user: {
        id: decoded.id,
        name: decoded.name,
        user: decoded.user,
        role: 'admin'
      },
      jti: decoded.jti,
      exp: decoded.exp
    };
  } catch (e) {
    return null;
  }
}

function normalizeClientKey_(clientId) {
  var clean = String(clientId || 'default').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 48);
  return 'cid_' + (clean || 'default');
}

function getLockoutMap_() {
  var raw = PropertiesService.getScriptProperties().getProperty('HO_MAI_LOCKOUTS');
  if (!raw) return {};
  try {
    return JSON.parse(raw) || {};
  } catch (e) {
    return {};
  }
}

function saveLockoutMap_(map) {
  PropertiesService.getScriptProperties().setProperty('HO_MAI_LOCKOUTS', JSON.stringify(map));
}

function getLockStatus_(clientId) {
  var key = normalizeClientKey_(clientId);
  var map = getLockoutMap_();
  var rec = map[key];
  var now = new Date().getTime();
  if (rec && rec.lockedUntil && now < rec.lockedUntil) {
    return {
      locked: true,
      attempts: Math.max(rec.attempts || MAX_LOGIN_ATTEMPTS, MAX_LOGIN_ATTEMPTS),
      remainingAttempts: 0,
      lockedUntil: rec.lockedUntil,
      remainingSeconds: Math.ceil((rec.lockedUntil - now) / 1000)
    };
  }
  if (rec && rec.lockedUntil && now >= rec.lockedUntil) {
    delete map[key];
    saveLockoutMap_(map);
    rec = null;
  }
  var attempts = rec && rec.attempts ? Number(rec.attempts) : 0;
  return {
    locked: false,
    attempts: attempts,
    remainingAttempts: Math.max(0, MAX_LOGIN_ATTEMPTS - attempts),
    lockedUntil: null,
    remainingSeconds: 0
  };
}

function recordFailedAttempt_(clientId) {
  var lock = LockService.getScriptLock();
  lock.waitLock(5000);
  try {
    var key = normalizeClientKey_(clientId);
    var map = getLockoutMap_();
    var rec = map[key] || { attempts: 0, lockedUntil: null };
    var now = new Date().getTime();
    if (rec.lockedUntil && now < rec.lockedUntil) {
      return getLockStatus_(clientId);
    }
    var nextAttempts = Number(rec.attempts || 0) + 1;
    var lockedUntil = nextAttempts >= MAX_LOGIN_ATTEMPTS ? (now + LOCKOUT_DURATION_MS) : null;
    map[key] = { attempts: nextAttempts, lockedUntil: lockedUntil };
    saveLockoutMap_(map);
    return {
      locked: Boolean(lockedUntil),
      attempts: nextAttempts,
      remainingAttempts: Math.max(0, MAX_LOGIN_ATTEMPTS - nextAttempts),
      lockedUntil: lockedUntil,
      remainingSeconds: lockedUntil ? Math.ceil(LOCKOUT_DURATION_MS / 1000) : 0
    };
  } finally {
    lock.releaseLock();
  }
}

function clearLockout_(clientId) {
  var key = normalizeClientKey_(clientId);
  var map = getLockoutMap_();
  if (map[key]) {
    delete map[key];
    saveLockoutMap_(map);
  }
}

function isSafeBrandingValue_(val) {
  if (!val) return true;
  var s = String(val).trim();
  if (s === DEFAULT_BACKGROUND_URL) return true;
  if (/^https?:\/\/.+/i.test(s)) return true;
  if (/^data:image\/(png|jpeg|jpg|webp);base64,[A-Za-z0-9+/=]+$/i.test(s)) return true;
  return false;
}

function getStoredBranding_() {
  var props = PropertiesService.getScriptProperties();
  var chunkCount = Number(props.getProperty('HO_MAI_BRANDING_CHUNKS') || 0);
  var raw = '';
  if (chunkCount > 0) {
    for (var i = 0; i < chunkCount; i++) {
      raw += (props.getProperty('HO_MAI_BRANDING_' + i) || '');
    }
  } else {
    raw = props.getProperty('HO_MAI_BRANDING') || '';
  }
  var def = {
    logoUrl: '',
    backgroundUrl: DEFAULT_BACKGROUND_URL,
    backgroundOpacity: 0.14
  };
  if (!raw) return def;
  try {
    var parsed = JSON.parse(raw);
    return {
      logoUrl: typeof parsed.logoUrl === 'string' ? parsed.logoUrl : '',
      backgroundUrl: typeof parsed.backgroundUrl === 'string' ? parsed.backgroundUrl : DEFAULT_BACKGROUND_URL,
      backgroundOpacity: typeof parsed.backgroundOpacity === 'number' ? parsed.backgroundOpacity : 0.14
    };
  } catch (e) {
    return def;
  }
}

function saveStoredBranding_(branding) {
  var current = getStoredBranding_();
  var nextLogo = branding.logoUrl !== undefined ? String(branding.logoUrl).trim() : current.logoUrl;
  var nextBg = branding.backgroundUrl !== undefined ? String(branding.backgroundUrl).trim() : current.backgroundUrl;
  if (!isSafeBrandingValue_(nextLogo) || !isSafeBrandingValue_(nextBg)) {
    throw new Error('URL/dữ liệu ảnh không hợp lệ (chỉ hỗ trợ link https hoặc PNG/JPG/WebP).');
  }
  var nextOp = branding.backgroundOpacity !== undefined ? Number(branding.backgroundOpacity) : current.backgroundOpacity;
  if (isNaN(nextOp)) nextOp = 0.14;
  nextOp = Math.min(0.65, Math.max(0, nextOp));

  var nextObj = {
    logoUrl: nextLogo,
    backgroundUrl: nextBg,
    backgroundOpacity: nextOp
  };
  var serialized = JSON.stringify(nextObj);
  if (serialized.length > 90000) {
    throw new Error('Ảnh quá lớn để lưu trực tiếp trên Google Apps Script (tối đa ~65KB mỗi ảnh). Hãy nén nhỏ ảnh hoặc dán đường dẫn URL https://.');
  }

  var props = PropertiesService.getScriptProperties();
  var oldChunks = Number(props.getProperty('HO_MAI_BRANDING_CHUNKS') || 0);
  for (var i = 0; i < oldChunks; i++) {
    props.deleteProperty('HO_MAI_BRANDING_' + i);
  }
  props.deleteProperty('HO_MAI_BRANDING');

  var chunkSize = 8000;
  var numChunks = Math.ceil(serialized.length / chunkSize);
  for (var c = 0; c < numChunks; c++) {
    props.setProperty('HO_MAI_BRANDING_' + c, serialized.substring(c * chunkSize, (c + 1) * chunkSize));
  }
  props.setProperty('HO_MAI_BRANDING_CHUNKS', String(numChunks));
  return nextObj;
}

function readAllSheetsPublic_(ss, includeMaskedLogin) {
  var sheets = ss.getSheets();
  var result = [];
  for (var i = 0; i < sheets.length; i++) {
    var parsed = parseSingleSheet_(sheets[i]);
    if (parsed.category === 'LOGIN' || String(parsed.name || '').toUpperCase() === 'LOGIN') {
      if (includeMaskedLogin) {
        result.push(maskLoginSheet_(parsed));
      }
    } else {
      result.push(parsed);
    }
  }
  return result;
}

function handleAuthLogin_(ss, body) {
  var clientId = body.clientId || 'default';
  var lockState = getLockStatus_(clientId);
  if (lockState.locked) {
    return {
      ok: false,
      status: 429,
      locked: true,
      attempts: lockState.attempts,
      remainingAttempts: 0,
      lockedUntil: lockState.lockedUntil,
      remainingSeconds: lockState.remainingSeconds,
      error: 'Bạn đã nhập sai quá 3 lần. Ứng dụng đã tạm đóng, vui lòng thử lại sau 1 giờ.'
    };
  }

  var cleanUser = String(body.username || '').trim().toLowerCase();
  var cleanPass = String(body.password || '').trim();
  if (!cleanUser || !cleanPass) {
    return {
      ok: false,
      status: 400,
      locked: false,
      attempts: lockState.attempts,
      remainingAttempts: lockState.remainingAttempts,
      error: 'Vui lòng nhập đầy đủ Tên đăng nhập và Mật khẩu.'
    };
  }

  var loginSheet = findSheetCaseInsensitive_(ss, 'LOGIN');
  if (!loginSheet) {
    return {
      ok: false,
      status: 404,
      error: 'Không tìm thấy tab LOGIN trong Google Sheet.'
    };
  }

  var loginRows = parseSingleSheet_(loginSheet).rows || [];
  var candidate = null;
  for (var i = 0; i < loginRows.length; i++) {
    if (String(loginRows[i].user || '').trim().toLowerCase() === cleanUser) {
      candidate = loginRows[i];
      break;
    }
  }

  if (!candidate || !safeEqualStr_(String(candidate.password || '').trim(), cleanPass)) {
    var failState = recordFailedAttempt_(clientId);
    if (failState.locked) {
      return {
        ok: false,
        status: 429,
        locked: true,
        attempts: failState.attempts,
        remainingAttempts: 0,
        lockedUntil: failState.lockedUntil,
        remainingSeconds: failState.remainingSeconds,
        error: 'Bạn đã nhập sai quá 3 lần. Ứng dụng đã tạm đóng, vui lòng thử lại sau 1 giờ.'
      };
    }
    return {
      ok: false,
      status: 401,
      locked: false,
      attempts: failState.attempts,
      remainingAttempts: failState.remainingAttempts,
      error: 'Tên đăng nhập hoặc mật khẩu không chính xác. Còn ' + failState.remainingAttempts + ' lần thử trước khi ứng dụng khóa 1 giờ.'
    };
  }

  if (candidate.role !== 'admin') {
    var roleFail = recordFailedAttempt_(clientId);
    if (roleFail.locked) {
      return {
        ok: false,
        status: 429,
        locked: true,
        attempts: roleFail.attempts,
        remainingAttempts: 0,
        lockedUntil: roleFail.lockedUntil,
        remainingSeconds: roleFail.remainingSeconds,
        error: 'Bạn đã nhập sai quá 3 lần. Ứng dụng đã tạm đóng, vui lòng thử lại sau 1 giờ.'
      };
    }
    return {
      ok: false,
      status: 403,
      locked: false,
      attempts: roleFail.attempts,
      remainingAttempts: roleFail.remainingAttempts,
      error: 'Chỉ tài khoản có ROLE = admin trên sheet LOGIN mới được đăng nhập. Còn ' + roleFail.remainingAttempts + ' lần thử.'
    };
  }

  clearLockout_(clientId);
  var authUser = {
    id: candidate.stt,
    name: candidate.name,
    user: candidate.user,
    role: 'admin'
  };
  var rememberMe = Boolean(body.rememberMe);
  var token = signAdminToken_(authUser, rememberMe);
  return {
    ok: true,
    token: token,
    user: authUser,
    rememberMe: rememberMe,
    authSource: 'google-sheet-webhook'
  };
}

/**
 * Xu ly GET request (ping, authStatus, authMe, getPublicData - ho tro CORS truc tiep tu GitHub Pages)
 */
function doGet(e) {
  try {
    var params = (e && e.parameter) ? e.parameter : {};
    var action = params.action || 'ping';
    var ss = getSpreadsheet_();
    if (!ss) {
      return jsonResponse_({
        ok: false,
        status: 500,
        error: 'Không tìm thấy Google Sheet liên kết. Hãy tạo Apps Script từ menu Tiện ích mở rộng -> Apps Script trong Google Sheet hoặc cài đặt Script Property SPREADSHEET_ID.'
      });
    }

    if (action === 'ping') {
      return jsonResponse_({
        ok: true,
        version: CODE_GS_VERSION,
        spreadsheetName: ss.getName(),
        spreadsheetId: ss.getId(),
        sheets: ss.getSheets().map(function(s) { return s.getName(); }),
        timestamp: new Date().toISOString()
      });
    }

    if (action === 'authStatus') {
      var st = getLockStatus_(params.clientId || 'default');
      return jsonResponse_({
        ok: true,
        locked: st.locked,
        attempts: st.attempts,
        remainingAttempts: st.remainingAttempts,
        lockedUntil: st.lockedUntil,
        remainingSeconds: st.remainingSeconds,
        hasWebhook: true,
        needsInitialSetup: false,
        defaultSpreadsheetId: ss.getId(),
        spreadsheetName: ss.getName(),
        sheetCount: ss.getSheets().length
      });
    }

    if (action === 'authMe') {
      var verified = verifyAdminToken_(params.token || '');
      if (!verified) {
        return jsonResponse_({ ok: false, status: 401, error: 'Phiên đăng nhập không hợp lệ hoặc đã hết hạn.' });
      }
      return jsonResponse_({ ok: true, user: verified.user });
    }

    if (action === 'getPublicData') {
      var adminSession = verifyAdminToken_(params.token || '');
      var isAdmin = Boolean(adminSession);
      return jsonResponse_({
        ok: true,
        version: CODE_GS_VERSION,
        spreadsheetName: ss.getName(),
        spreadsheetId: ss.getId(),
        branding: getStoredBranding_(),
        sheets: readAllSheetsPublic_(ss, isAdmin),
        timestamp: new Date().toISOString()
      });
    }

    return jsonResponse_({ ok: false, status: 400, error: 'Action GET không hợp lệ: ' + action });
  } catch (err) {
    return jsonResponse_({ ok: false, status: 500, error: err.message });
  }
}

/**
 * Xu ly POST request (tu GitHub Pages CORS text/plain va tu Backend Express)
 */
function doPost(e) {
  try {
    var raw = e && e.postData && e.postData.contents ? e.postData.contents : '{}';
    var body = JSON.parse(raw);
    var action = body.action || '';

    var ss = getSpreadsheet_();
    if (!ss) {
      return jsonResponse_({
        ok: false,
        status: 500,
        error: 'Không tìm thấy Google Sheet liên kết. Hãy tạo Apps Script từ menu Tiện ích mở rộng -> Apps Script trong Google Sheet.'
      });
    }

    if (action === 'ping') {
      return jsonResponse_({
        ok: true,
        version: CODE_GS_VERSION,
        spreadsheetName: ss.getName(),
        spreadsheetId: ss.getId(),
        sheets: ss.getSheets().map(function(s) { return s.getName(); }),
        timestamp: new Date().toISOString()
      });
    }

    if (action === 'authLogin') {
      return jsonResponse_(handleAuthLogin_(ss, body));
    }

    if (action === 'authLogout') {
      var logoutSess = verifyAdminToken_(body.token || '');
      if (logoutSess) {
        revokeTokenId_(logoutSess.jti, logoutSess.exp);
      }
      return jsonResponse_({ ok: true });
    }

    if (action === 'getPublicData') {
      var pubAdmin = verifyAdminToken_(body.token || '');
      return jsonResponse_({
        ok: true,
        version: CODE_GS_VERSION,
        spreadsheetName: ss.getName(),
        spreadsheetId: ss.getId(),
        branding: getStoredBranding_(),
        sheets: readAllSheetsPublic_(ss, Boolean(pubAdmin)),
        timestamp: new Date().toISOString()
      });
    }

    // Cac action ben duoi YEU CAU Admin Token hop le
    var adminSession = verifyAdminToken_(body.token || '');
    if (!adminSession) {
      return jsonResponse_({
        ok: false,
        status: 401,
        error: 'Chưa xác thực Admin hoặc phiên đăng nhập đã hết hạn. Vui lòng đăng nhập lại.'
      });
    }

    if (action === 'authTestLogin') {
      var lSheet = findSheetCaseInsensitive_(ss, 'LOGIN');
      var lRows = lSheet ? (parseSingleSheet_(lSheet).rows || []) : [];
      return jsonResponse_({
        ok: true,
        source: 'webhook',
        count: lRows.length,
        accounts: lRows.map(function(r) {
          return { stt: r.stt, name: r.name, user: r.user, role: r.role };
        })
      });
    }

    if (action === 'saveBranding') {
      var savedBranding = saveStoredBranding_(body.branding || {});
      return jsonResponse_({
        ok: true,
        branding: savedBranding
      });
    }

    if (action === 'getAllData') {
      return jsonResponse_({
        ok: true,
        version: CODE_GS_VERSION,
        spreadsheetName: ss.getName(),
        spreadsheetId: ss.getId(),
        branding: getStoredBranding_(),
        sheets: readAllSheetsPublic_(ss, true),
        timestamp: new Date().toISOString()
      });
    }

    if (action === 'getSheet' && body.sheetName) {
      var targetSheet = findSheetCaseInsensitive_(ss, body.sheetName);
      if (!targetSheet) {
        return jsonResponse_({ ok: false, status: 404, error: 'Không tìm thấy sheet: ' + body.sheetName });
      }
      return jsonResponse_({
        ok: true,
        sheet: maskLoginSheet_(parseSingleSheet_(targetSheet))
      });
    }

    if (action === 'createSheet') {
      var sheetDoc = body.sheet;
      if (!sheetDoc || !sheetDoc.name) {
        return jsonResponse_({ ok: false, status: 400, error: 'Thiếu thông tin sheet.' });
      }
      writeSheetDocument_(ss, sheetDoc, true);
      var createdSheet = findSheetCaseInsensitive_(ss, sheetDoc.name);
      var parsedCreated = createdSheet ? maskLoginSheet_(parseSingleSheet_(createdSheet)) : sheetDoc;
      return jsonResponse_({
        ok: true,
        message: 'Đã tạo sheet ' + sheetDoc.name,
        sheet: parsedCreated
      });
    }

    if (action === 'syncSheet') {
      var doc = body.sheet;
      if (!doc || !doc.name) {
        return jsonResponse_({ ok: false, status: 400, error: 'Thiếu dữ liệu sheet.' });
      }
      writeSheetDocument_(ss, doc, false);
      return jsonResponse_({ ok: true, message: 'Đã đồng bộ sheet ' + doc.name });
    }

    if (action === 'syncAll') {
      var sheets = body.sheets || [];
      for (var i = 0; i < sheets.length; i++) {
        writeSheetDocument_(ss, sheets[i], false);
      }
      return jsonResponse_({
        ok: true,
        message: 'Đã đồng bộ ' + sheets.length + ' sheets lên Google Sheets.',
        timestamp: new Date().toISOString()
      });
    }

    if (action === 'deleteSheet') {
      var nameToDelete = body.sheetName;
      var target = findSheetCaseInsensitive_(ss, nameToDelete);
      if (target && String(nameToDelete).toUpperCase() !== 'LOGIN' && String(nameToDelete).toUpperCase() !== 'DSHO') {
        ss.deleteSheet(target);
      }
      return jsonResponse_({ ok: true, message: 'Đã xóa sheet ' + nameToDelete });
    }

    return jsonResponse_({ ok: false, status: 400, error: 'Action POST không hợp lệ: ' + action });
  } catch (err) {
    return jsonResponse_({ ok: false, status: 500, error: err.message });
  }
}

/**
 * ============================================================================
 * CAC HAM DOC VA CHUYEN DOI DU LIEU TU GOOGLE SHEETS SANG JSON APP
 * ============================================================================
 */
function detectCategory_(name) {
  var upper = String(name).toUpperCase().trim();
  if (upper === 'LOGIN') return 'LOGIN';
  if (upper === 'DSHO') return 'DSHO';
  if (upper.indexOf('VAY') === 0) return 'VAY';
  if (upper.indexOf('GOP') === 0) return 'GOP';
  if (upper.indexOf('TC') === 0) return 'TC';
  return 'CUSTOM';
}

function extractYear_(name) {
  var m = String(name).match(/(\d{2,4})$/);
  if (!m) return undefined;
  var num = parseInt(m[1], 10);
  return num < 100 ? 2000 + num : num;
}

function toNumber_(val) {
  if (typeof val === 'number') return isNaN(val) ? 0 : val;
  if (val === undefined || val === null || val === '') return 0;
  var str = String(val).trim();
  if (/^-?\d+\.\d{1,4}$/.test(str)) {
    var dec = parseFloat(str);
    return isNaN(dec) ? 0 : dec;
  }
  var cleaned = str.replace(/\./g, '').replace(/,/g, '').replace(/[^\d-]/g, '');
  var n = parseFloat(cleaned);
  return isNaN(n) ? 0 : n;
}

function sanitizeSheetCell_(val) {
  if (typeof val === 'string' && /^[=+\-@\t\r]/.test(val)) {
    return "'" + val;
  }
  return val;
}

function readAllSheets_(ss) {
  var sheets = ss.getSheets();
  var result = [];
  for (var i = 0; i < sheets.length; i++) {
    result.push(parseSingleSheet_(sheets[i]));
  }
  return result;
}

function parseSingleSheet_(sheet) {
  var name = sheet.getName();
  var category = detectCategory_(name);
  var year = extractYear_(name);
  var values = sheet.getDataRange().getValues();

  if (category === 'LOGIN') {
    var headers = values[0] || [];
    var colId = 0, colName = 1, colUser = 2, colPass = 3, colRole = 4;
    for (var h = 0; h < headers.length; h++) {
      var key = String(headers[h] || '').toUpperCase().trim();
      if (key === 'ID' || key === 'STT') colId = h;
      else if (key === 'NAME' || key === 'HỌ TÊN' || key === 'HỌ VÀ TÊN') colName = h;
      else if (key === 'USER' || key === 'USERNAME' || key === 'TÀI KHOẢN') colUser = h;
      else if (key === 'PASSWORD' || key === 'PASS' || key === 'MẬT KHẨU') colPass = h;
      else if (key === 'ROLE' || key === 'QUYỀN') colRole = h;
    }

    var loginRows = [];
    for (var r = 1; r < values.length; r++) {
      var row = values[r];
      var uVal = row[colUser] !== undefined && row[colUser] !== null ? String(row[colUser]).trim() : '';
      var nVal = row[colName] !== undefined && row[colName] !== null ? String(row[colName]).trim() : '';
      if (!uVal && !nVal) continue;
      var pVal = row[colPass] !== undefined && row[colPass] !== null ? String(row[colPass]).trim() : '';
      var roleVal = row[colRole] !== undefined && row[colRole] !== null ? String(row[colRole]).trim().toLowerCase() : 'user';
      loginRows.push({
        id: 'login-' + r,
        stt: toNumber_(row[colId]) || (loginRows.length + 1),
        name: nVal,
        user: uVal,
        password: pVal,
        role: roleVal === 'admin' ? 'admin' : 'user'
      });
    }
    return {
      name: name,
      category: 'LOGIN',
      title: 'QUẢN LÝ TÀI KHOẢN ĐĂNG NHẬP',
      isCore: true,
      rows: loginRows
    };
  }

  if (category === 'DSHO') {
    var dshoRows = [];
    for (var r = 3; r < values.length; r++) {
      var row = values[r];
      var dshoName = String(row[1] || '').trim();
      if (!dshoName || dshoName.toUpperCase().indexOf('TỔNG') === 0) continue;
      dshoRows.push({
        id: 'dsho-' + r,
        stt: toNumber_(row[0]) || (dshoRows.length + 1),
        hoVaTen: dshoName,
        soDienThoai: String(row[2] || '')
      });
    }
    return {
      name: name,
      category: 'DSHO',
      title: String((values[0] && values[0][0]) || 'DANH SÁCH HỌ MAI'),
      isCore: true,
      rows: dshoRows
    };
  }

  if (category === 'VAY') {
    var vayRows = [];
    var title = String((values[0] && values[0][1]) || (values[0] && values[0][0]) || ('DANH SÁCH VAY TIỀN HỌ MAI NĂM ' + (year || '')));
    var subtitle = String((values[1] && values[1][2]) || (values[1] && values[1][1]) || '');
    var carryOverLabel = (values[3] && values[3][4]) ? String(values[3][4]) : ('Vay ' + ((year || 2025) - 1) + ' chưa trả');

    for (var r = 4; r < values.length; r++) {
      var row = values[r];
      var hoTen = String(row[1] || '').trim();
      if (!hoTen || hoTen.toUpperCase().indexOf('TỔNG') === 0) continue;
      var soTien = toNumber_(row[2]);
      var vayTruoc = toNumber_(row[4]);
      var hasTongVay = row[5] !== '' && row[5] !== null && row[5] !== undefined;
      var tongVay = hasTongVay ? toNumber_(row[5]) : (soTien + vayTruoc);
      var hasLai = row[6] !== '' && row[6] !== null && row[6] !== undefined;
      var lai = hasLai ? toNumber_(row[6]) : Math.round(tongVay * 0.25);
      var hasTongCong = row[8] !== '' && row[8] !== null && row[8] !== undefined;
      var tongCong = hasTongCong ? toNumber_(row[8]) : (tongVay + lai);
      vayRows.push({
        id: name.toLowerCase() + '-' + r,
        stt: toNumber_(row[0]) || (vayRows.length + 1),
        hoVaTen: hoTen,
        soTien: soTien,
        kyVay: String(row[3] || ''),
        vayNamTruocChuaTra: vayTruoc,
        tongVay: tongVay,
        lai: lai,
        kyTra: String(row[7] || ''),
        tongCong: tongCong,
        ghiChu: String(row[9] || '')
      });
    }
    return {
      name: name,
      category: 'VAY',
      title: title,
      subtitle: subtitle,
      year: year,
      carryOverLabel: carryOverLabel,
      interestRate: 0.25,
      rows: vayRows
    };
  }

  if (category === 'GOP') {
    var gopRows = [];
    var gopTitle = String((values[0] && values[0][0]) || ('DANH SÁCH ĐÓNG GÓP NĂM ' + (year || '')));
    for (var r = 3; r < values.length; r++) {
      var row = values[r];
      var ten = String(row[1] || '').trim();
      if (!ten || ten.toUpperCase().indexOf('TỔNG') === 0) continue;
      var stRaw = String(row[3] || '').trim().toLowerCase();
      gopRows.push({
        id: name.toLowerCase() + '-' + r,
        stt: toNumber_(row[0]) || (gopRows.length + 1),
        hoVaTen: ten,
        soTien: toNumber_(row[2]),
        trangThai: stRaw === 'đã thu' ? 'đã thu' : 'chưa thu'
      });
    }
    return {
      name: name,
      category: 'GOP',
      title: gopTitle,
      year: year,
      rows: gopRows
    };
  }

  if (category === 'TC') {
    var tcTitle = String((values[0] && values[0][1]) || (values[0] && values[0][0]) || ('DANH SÁCH THU CHI NĂM ' + (year || '')));
    var tcSubtitle = String((values[1] && values[1][2]) || (values[1] && values[1][1]) || '');
    var thuRows = [];
    var chiRows = [];
    var choVay = values[4] ? toNumber_(values[4][11]) : 0;

    for (var r = 4; r < values.length; r++) {
      var row = values[r];
      var thuName = String(row[1] || '').trim();
      if (thuName && thuName.toUpperCase().indexOf('TỔNG') !== 0) {
        thuRows.push({
          id: name.toLowerCase() + '-thu-' + r,
          stt: toNumber_(row[0]) || (thuRows.length + 1),
          noiDung: thuName,
          soTien: toNumber_(row[2]),
          ghiChu: String(row[4] || '')
        });
      }
      var chiName = String(row[7] || '').trim();
      if (chiName && chiName.toUpperCase().indexOf('TỔNG') !== 0) {
        chiRows.push({
          id: name.toLowerCase() + '-chi-' + r,
          stt: toNumber_(row[6]) || (chiRows.length + 1),
          noiDung: chiName,
          soTien: toNumber_(row[8]),
          ghiChu: String(row[9] || '')
        });
      }
    }
    return {
      name: name,
      category: 'TC',
      title: tcTitle,
      subtitle: tcSubtitle,
      year: year,
      choVay: choVay,
      rows: [],
      thuRows: thuRows,
      chiRows: chiRows
    };
  }

  // CUSTOM fallback
  var headers = values[0] || ['STT', 'Nội dung', 'Giá trị'];
  var customCols = [];
  for (var c = 1; c < headers.length; c++) {
    customCols.push({
      key: 'col_' + c,
      label: String(headers[c] || ('Cột ' + c)),
      type: 'text'
    });
  }
  var customRows = [];
  for (var r = 1; r < values.length; r++) {
    var rowObj = { id: name.toLowerCase() + '-' + r, stt: toNumber_(values[r][0]) || r };
    for (var c = 1; c < headers.length; c++) {
      rowObj['col_' + c] = values[r][c] !== undefined ? values[r][c] : '';
    }
    customRows.push(rowObj);
  }
  return {
    name: name,
    category: 'CUSTOM',
    title: name,
    customColumns: customCols,
    rows: customRows
  };
}

/**
 * ============================================================================
 * CAC HAM GHI DU LIEU TU WEB APP XUONG GOOGLE SHEETS (KEM FORMAT & CONG THUC)
 * ============================================================================
 */
function writeSheetDocument_(ss, doc, failIfExists) {
  var sheet = findSheetCaseInsensitive_(ss, doc.name);
  var cat = doc.category;

  if (cat === 'LOGIN') {
    var existingPassByUser = {};
    var existingPassByRowId = {};
    if (sheet && sheet.getLastRow() > 1) {
      var oldVals = sheet.getDataRange().getValues();
      var hdr = oldVals[0] || [];
      var cUser = 2, cPass = 3;
      for (var hi = 0; hi < hdr.length; hi++) {
        var hk = String(hdr[hi] || '').toUpperCase().trim();
        if (hk === 'USER' || hk === 'USERNAME' || hk === 'TÀI KHOẢN') cUser = hi;
        else if (hk === 'PASSWORD' || hk === 'PASS' || hk === 'MẬT KHẨU') cPass = hi;
      }
      for (var er = 1; er < oldVals.length; er++) {
        var oldPass = oldVals[er][cPass] !== undefined && oldVals[er][cPass] !== null ? String(oldVals[er][cPass]) : '';
        existingPassByRowId['login-' + er] = oldPass;
        var oldU = String(oldVals[er][cUser] || '').trim().toLowerCase();
        if (oldU) {
          existingPassByUser[oldU] = oldPass;
        }
      }
    }
    if (!sheet) {
      sheet = ss.insertSheet(doc.name);
    } else {
      sheet.clear();
    }
    sheet.getRange(1, 1, 1, 5).setValues([['ID', 'NAME', 'USER', 'PASSWORD', 'ROLE']]).setFontWeight('bold');
    var rows = (doc.rows || []).map(function(r, idx) {
      var uKey = String(r.user || '').trim().toLowerCase();
      var prevUKey = String(r.prevUser || '').trim().toLowerCase();
      var incomingPass = r.password ? String(r.password) : '';
      var preservedPass = existingPassByUser[uKey] || (prevUKey ? existingPassByUser[prevUKey] : '') || existingPassByRowId[r.id] || '';
      var finalPass = (incomingPass && incomingPass !== '••••••••') ? incomingPass : preservedPass;
      return [
        r.stt || (idx + 1),
        sanitizeSheetCell_(r.name || ''),
        sanitizeSheetCell_(r.user || ''),
        sanitizeSheetCell_(finalPass),
        sanitizeSheetCell_(r.role || 'user')
      ];
    });
    if (rows.length > 0) {
      sheet.getRange(2, 1, rows.length, 5).setValues(rows);
    }
    return;
  }

  if (sheet && failIfExists) {
    sheet.clear();
  } else if (!sheet) {
    sheet = ss.insertSheet(doc.name);
  } else {
    sheet.clear();
  }

  if (cat === 'DSHO') {
    sheet.getRange('A1').setValue(sanitizeSheetCell_(doc.title || 'DANH SÁCH HỌ MAI')).setFontWeight('bold').setFontSize(13);
    sheet.getRange(3, 1, 1, 3).setValues([['STT', 'Họ và tên', 'SỐ ĐIỆN THOẠI']]).setFontWeight('bold');
    var dshoRows = (doc.rows || []).map(function(r, idx) {
      return [r.stt || (idx + 1), sanitizeSheetCell_(r.hoVaTen || ''), sanitizeSheetCell_(r.soDienThoai || '')];
    });
    if (dshoRows.length > 0) {
      var range = sheet.getRange(4, 1, dshoRows.length, 3);
      range.setValues(dshoRows);
      sheet.getRange(3, 1, dshoRows.length + 1, 3).setBorder(true, true, true, true, true, true);
    }
    return;
  }

  if (cat === 'VAY') {
    sheet.getRange('B1').setValue(sanitizeSheetCell_(doc.title || ('DANH SÁCH VAY TIỀN HỌ MAI NĂM ' + (doc.year || '')))).setFontWeight('bold').setFontSize(13);
    if (doc.subtitle) sheet.getRange('C2').setValue(sanitizeSheetCell_(doc.subtitle)).setFontStyle('italic');

    var rate = doc.interestRate || 0.25;
    var carryLabel = sanitizeSheetCell_(doc.carryOverLabel || ('Vay ' + ((doc.year || 2025) - 1) + ' chưa trả'));
    var vayHeaders = [['STT', 'Họ và tên', 'Số tiền', 'Ký vay', carryLabel, 'Tổng vay', 'Lãi', 'Ký trả', 'tổng cộng', 'Ghi chú']];
    sheet.getRange(4, 1, 1, 10).setValues(vayHeaders).setFontWeight('bold').setHorizontalAlignment('center');

    var list = doc.rows || [];
    if (list.length > 0) {
      var vayValues = list.map(function(r, idx) {
        var rowNum = 5 + idx;
        var st = Number(r.soTien || 0);
        var vt = Number(r.vayNamTruocChuaTra || 0);
        var tv = st + vt;
        var expectedLai = Math.round(tv * rate);
        var useFormulaLai = (r.lai === undefined || r.lai === null || r.lai === '' || Number(r.lai) === expectedLai);
        var laiCell = useFormulaLai ? ('=F' + rowNum + '*' + rate) : Number(r.lai);
        return [
          r.stt || (idx + 1),
          sanitizeSheetCell_(r.hoVaTen || ''),
          st,
          sanitizeSheetCell_(r.kyVay || ''),
          vt,
          '=C' + rowNum + '+E' + rowNum,
          laiCell,
          sanitizeSheetCell_(r.kyTra || ''),
          '=F' + rowNum + '+G' + rowNum,
          sanitizeSheetCell_(r.ghiChu || '')
        ];
      });
      sheet.getRange(5, 1, vayValues.length, 10).setValues(vayValues);
      var totalRow = 5 + vayValues.length;
      sheet.getRange(totalRow, 2).setValue('TỔNG CHO VAY').setFontWeight('bold');
      sheet.getRange(totalRow, 3).setFormula('=SUM(C5:C' + (totalRow - 1) + ')').setFontWeight('bold').setFontColor('#DC2626');
      sheet.getRange(totalRow, 6).setFormula('=SUM(F5:F' + (totalRow - 1) + ')').setFontWeight('bold').setFontColor('#DC2626');
      sheet.getRange(totalRow, 7).setFormula('=SUM(G5:G' + (totalRow - 1) + ')').setFontWeight('bold').setFontColor('#DC2626');
      sheet.getRange(totalRow, 9).setFormula('=SUM(I5:I' + (totalRow - 1) + ')').setFontWeight('bold').setFontColor('#DC2626');
      sheet.getRange(5, 3, vayValues.length + 1, 1).setNumberFormat('#,##0');
      sheet.getRange(5, 5, vayValues.length + 1, 3).setNumberFormat('#,##0');
      sheet.getRange(5, 9, vayValues.length + 1, 1).setNumberFormat('#,##0');
      sheet.getRange(4, 1, vayValues.length + 2, 10).setBorder(true, true, true, true, true, true);
    }
    return;
  }

  if (cat === 'GOP') {
    sheet.getRange('A1').setValue(sanitizeSheetCell_(doc.title || ('DANH SÁCH ĐÓNG GÓP NĂM ' + (doc.year || '')))).setFontWeight('bold').setFontSize(13);
    sheet.getRange(3, 1, 1, 4).setValues([['STT', 'HỌ VÀ TÊN', 'SỐ TIỀN', 'TRẠNG THÁI']]).setFontWeight('bold');
    var gopList = doc.rows || [];
    if (gopList.length > 0) {
      var gopValues = gopList.map(function(r, idx) {
        return [r.stt || (idx + 1), sanitizeSheetCell_(r.hoVaTen || ''), Number(r.soTien || 0), sanitizeSheetCell_(r.trangThai || 'chưa thu')];
      });
      sheet.getRange(4, 1, gopValues.length, 4).setValues(gopValues);
      var sumRow = 4 + gopValues.length;
      sheet.getRange(sumRow, 2).setValue('TỔNG').setFontWeight('bold').setFontColor('#DC2626');
      sheet.getRange(sumRow, 3).setFormula('=SUM(C4:C' + (sumRow - 1) + ')').setFontWeight('bold').setFontColor('#DC2626');
      sheet.getRange(4, 3, gopValues.length + 1, 1).setNumberFormat('#,##0');
      sheet.getRange(3, 1, gopValues.length + 2, 4).setBorder(true, true, true, true, true, true);
    }
    return;
  }

  if (cat === 'TC') {
    var yr = doc.year || new Date().getFullYear();
    sheet.getRange('B1').setValue(sanitizeSheetCell_(doc.title || ('DANH SÁCH THU CHI NĂM ' + yr))).setFontWeight('bold').setFontSize(13);
    if (doc.subtitle) sheet.getRange('C2').setValue(sanitizeSheetCell_(doc.subtitle)).setFontStyle('italic');

    // Bang THU (A..E)
    sheet.getRange(4, 1, 1, 5).setValues([['STT', 'THU', 'Số tiền', 'TỔNG THU', 'Ghi chú']]).setFontWeight('bold');
    var thuList = doc.thuRows || [];
    if (thuList.length > 0) {
      var thuVals = thuList.map(function(r, idx) {
        return [r.stt || (idx + 1), sanitizeSheetCell_(r.noiDung || ''), Number(r.soTien || 0), '', sanitizeSheetCell_(r.ghiChu || '')];
      });
      sheet.getRange(5, 1, thuVals.length, 5).setValues(thuVals);
      sheet.getRange(5, 4).setFormula('=SUM(C5:C' + (4 + thuVals.length) + ')').setFontWeight('bold').setFontColor('#DC2626');
      sheet.getRange(5, 3, thuVals.length, 2).setNumberFormat('#,##0');
      sheet.getRange(4, 1, thuVals.length + 1, 5).setBorder(true, true, true, true, true, true);
    }

    // Bang CHI & Tong hop (G..M)
    sheet.getRange(4, 7, 1, 7).setValues([['STT', 'CHI', 'Số tiền', 'Ghi chú', 'TỔNG CHI', 'CHO VAY', 'TỔNG NĂM ' + yr]]).setFontWeight('bold');
    var chiList = doc.chiRows || [];
    var rowCount = Math.max(chiList.length, 1);
    if (chiList.length > 0) {
      var chiVals = chiList.map(function(r, idx) {
        return [r.stt || (idx + 1), sanitizeSheetCell_(r.noiDung || ''), Number(r.soTien || 0), sanitizeSheetCell_(r.ghiChu || '')];
      });
      sheet.getRange(5, 7, chiVals.length, 4).setValues(chiVals);
      sheet.getRange(5, 11).setFormula('=SUM(I5:I' + (4 + chiVals.length) + ')').setFontWeight('bold').setFontColor('#DC2626');
    } else {
      sheet.getRange(5, 11).setValue(0).setFontWeight('bold').setFontColor('#DC2626');
    }
    sheet.getRange(5, 12).setValue(Number(doc.choVay || 0)).setFontWeight('bold').setFontColor('#DC2626');
    sheet.getRange(5, 13).setFormula('=D5-K5-L5').setFontWeight('bold').setFontColor('#DC2626');
    sheet.getRange(5, 9, rowCount, 1).setNumberFormat('#,##0');
    sheet.getRange(5, 11, 1, 3).setNumberFormat('#,##0');
    sheet.getRange(4, 7, rowCount + 1, 7).setBorder(true, true, true, true, true, true);
    return;
  }

  // CUSTOM
  var cols = doc.customColumns || [];
  var headerRow = ['STT'].concat(cols.map(function(c) { return sanitizeSheetCell_(c.label); }));
  sheet.getRange(1, 1, 1, headerRow.length).setValues([headerRow]).setFontWeight('bold');
  var cRows = (doc.rows || []).map(function(r, idx) {
    return [r.stt || (idx + 1)].concat(cols.map(function(c) {
      var v = r[c.key] !== undefined ? r[c.key] : '';
      return typeof v === 'string' ? sanitizeSheetCell_(v) : v;
    }));
  });
  if (cRows.length > 0) {
    sheet.getRange(2, 1, cRows.length, headerRow.length).setValues(cRows);
  }
}
