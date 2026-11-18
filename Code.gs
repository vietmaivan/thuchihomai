/**
 * ============================================================================
 * THU_CHI_HO_MAI - GOOGLE APPS SCRIPT WEBHOOK CONNECTOR (Code.gs)
 * ============================================================================
 * Ho tro ket noi TRUC TIEP tu Web tinh (GitHub Pages) va tu Backend Express.
 * Bao mat:
 * - Khong doc, khong dong bo va khong lo bat ky du lieu nao tu tab LOGIN.
 * - Xac thuc Admin 100% qua Firebase Realtime Database (thuchihomai/sessions).
 * - Moi thao tac ghi/sua/xoa/dong bo deu bat buoc co firebaseSessionId Admin hop le.
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
var FIREBASE_RTDB_URL = 'https://thuchihomai-default-rtdb.firebaseio.com';
var CODE_GS_VERSION = '2026.11.firebase-auth';
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

function isLoginSheetName_(name) {
  return String(name || '').toUpperCase().trim() === 'LOGIN';
}

function verifyFirebaseAdminSession_(sessionId) {
  var cleanSid = String(sessionId || '').trim().replace(/[^a-zA-Z0-9_-]/g, '');
  if (!cleanSid || cleanSid.length < 16) return null;
  try {
    var url = FIREBASE_RTDB_URL + '/thuchihomai/sessions/' + encodeURIComponent(cleanSid) + '.json';
    var res = UrlFetchApp.fetch(url, {
      method: 'get',
      muteHttpExceptions: true
    });
    if (res.getResponseCode() !== 200) return null;
    var raw = res.getContentText();
    if (!raw || raw === 'null') return null;
    var sess = JSON.parse(raw);
    if (!sess || sess.role !== 'admin') return null;
    if (typeof sess.exp !== 'number' || new Date().getTime() > sess.exp) return null;
    return {
      sid: cleanSid,
      user: {
        name: sess.name || sess.user || 'Admin',
        user: sess.user || '',
        role: 'admin'
      }
    };
  } catch (e) {
    return null;
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

function readAllSheetsPublic_(ss) {
  var sheets = ss.getSheets();
  var result = [];
  for (var i = 0; i < sheets.length; i++) {
    if (isLoginSheetName_(sheets[i].getName())) continue;
    result.push(parseSingleSheet_(sheets[i]));
  }
  return result;
}

function getNonLoginSheetNames_(ss) {
  return ss.getSheets()
    .map(function(s) { return s.getName(); })
    .filter(function(n) { return !isLoginSheetName_(n); });
}

/**
 * Xu ly GET request (ping, getPublicData - ho tro CORS truc tiep tu GitHub Pages)
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
        sheets: getNonLoginSheetNames_(ss),
        timestamp: new Date().toISOString()
      });
    }

    if (action === 'getPublicData') {
      return jsonResponse_({
        ok: true,
        version: CODE_GS_VERSION,
        spreadsheetName: ss.getName(),
        spreadsheetId: ss.getId(),
        branding: getStoredBranding_(),
        sheets: readAllSheetsPublic_(ss),
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
        sheets: getNonLoginSheetNames_(ss),
        timestamp: new Date().toISOString()
      });
    }

    if (action === 'getPublicData') {
      return jsonResponse_({
        ok: true,
        version: CODE_GS_VERSION,
        spreadsheetName: ss.getName(),
        spreadsheetId: ss.getId(),
        branding: getStoredBranding_(),
        sheets: readAllSheetsPublic_(ss),
        timestamp: new Date().toISOString()
      });
    }

    // Cac action ben duoi YEU CAU phien Admin Firebase hop le
    var adminSession = verifyFirebaseAdminSession_(body.firebaseSessionId || '');
    if (!adminSession) {
      return jsonResponse_({
        ok: false,
        status: 401,
        error: 'Chưa xác thực Admin Firebase hoặc phiên đăng nhập đã hết hạn. Vui lòng đăng nhập lại.'
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
        sheets: readAllSheetsPublic_(ss),
        timestamp: new Date().toISOString()
      });
    }

    if (action === 'getSheet' && body.sheetName) {
      if (isLoginSheetName_(body.sheetName)) {
        return jsonResponse_({ ok: false, status: 403, error: 'Tab LOGIN không được phép truy cập qua API.' });
      }
      var targetSheet = findSheetCaseInsensitive_(ss, body.sheetName);
      if (!targetSheet) {
        return jsonResponse_({ ok: false, status: 404, error: 'Không tìm thấy sheet: ' + body.sheetName });
      }
      return jsonResponse_({
        ok: true,
        sheet: parseSingleSheet_(targetSheet)
      });
    }

    if (action === 'createSheet') {
      var sheetDoc = body.sheet;
      if (!sheetDoc || !sheetDoc.name || isLoginSheetName_(sheetDoc.name)) {
        return jsonResponse_({ ok: false, status: 400, error: 'Tên sheet không hợp lệ.' });
      }
      writeSheetDocument_(ss, sheetDoc, true);
      var createdSheet = findSheetCaseInsensitive_(ss, sheetDoc.name);
      var parsedCreated = createdSheet ? parseSingleSheet_(createdSheet) : sheetDoc;
      return jsonResponse_({
        ok: true,
        message: 'Đã tạo sheet ' + sheetDoc.name,
        sheet: parsedCreated
      });
    }

    if (action === 'syncSheet') {
      var doc = body.sheet;
      if (!doc || !doc.name || isLoginSheetName_(doc.name)) {
        return jsonResponse_({ ok: false, status: 400, error: 'Dữ liệu sheet không hợp lệ.' });
      }
      writeSheetDocument_(ss, doc, false);
      return jsonResponse_({ ok: true, message: 'Đã đồng bộ sheet ' + doc.name });
    }

    if (action === 'syncAll') {
      var sheets = (body.sheets || []).filter(function(s) { return s && s.name && !isLoginSheetName_(s.name); });
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
      if (isLoginSheetName_(nameToDelete) || String(nameToDelete || '').toUpperCase().trim() === 'DSHO') {
        return jsonResponse_({ ok: false, status: 400, error: 'Không thể xóa sheet này.' });
      }
      var target = findSheetCaseInsensitive_(ss, nameToDelete);
      if (target) {
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
  return readAllSheetsPublic_(ss);
}

function parseSingleSheet_(sheet) {
  var name = sheet.getName();
  var category = detectCategory_(name);
  var year = extractYear_(name);
  var values = sheet.getDataRange().getValues();

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
  if (!doc || !doc.name || isLoginSheetName_(doc.name)) return;
  var sheet = findSheetCaseInsensitive_(ss, doc.name);
  var cat = doc.category;

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
