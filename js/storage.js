/* =========================================================
 * storage.js —— 本地存储层
 * 学生姓名、AI 配置：localStorage（数据小）
 * 作业及评语：IndexedDB（容量数百 MB，可存整班 40+ 份）
 * ========================================================= */
(function (global) {
  'use strict';

  var KEY_NAME = 'bc_student_name';
  var KEY_CLASS = 'bc_student_class';
  var KEY_CONFIG = 'bc_ai_config';
  var KEY_SUBS = 'bc_submissions'; // 旧版 localStorage 作业（仅用于一次性迁移）

  var DB_NAME = 'bencao_db';
  var DB_VERSION = 1;
  var STORE = 'submissions';

  function read(key, fallback) {
    try {
      var raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : fallback;
    } catch (e) {
      return fallback;
    }
  }

  function write(key, value) {
    localStorage.setItem(key, JSON.stringify(value));
  }

  /* ---------- 学生班级 / 姓名（仅作下次提交的预填，不锁定身份） ---------- */
  function getStudentName() {
    return localStorage.getItem(KEY_NAME) || '';
  }
  function setStudentName(name) {
    localStorage.setItem(KEY_NAME, name);
  }
  function getStudentClass() {
    return localStorage.getItem(KEY_CLASS) || '';
  }
  function setStudentClass(cls) {
    localStorage.setItem(KEY_CLASS, cls);
  }

  /* ---------- AI 配置 ---------- */
  function getAIConfig() {
    return read(KEY_CONFIG, {
      mode: 'mock',        // mock | real
      provider: 'zhipu',
      endpoint: 'https://open.bigmodel.cn/api/paas/v4/chat/completions',
      model: 'glm-4.6v-flash',
      apiKey: ''
    });
  }
  function setAIConfig(cfg) {
    write(KEY_CONFIG, cfg);
  }

  /* ---------- IndexedDB 作业存储 ---------- */
  var idb = null;          // IDBDatabase
  var memSubs = null;      // 启动后全量缓存，供同步读取
  var booted = false;

  function openDB() {
    return new Promise(function (resolve, reject) {
      if (!global.indexedDB) { reject(new Error('NO_IDB')); return; }
      var req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = function (e) {
        var db = e.target.result;
        if (!db.objectStoreNames.contains(STORE)) {
          db.createObjectStore(STORE, { keyPath: 'id' });
        }
      };
      req.onsuccess = function () { resolve(req.result); };
      req.onerror = function () { reject(req.error || new Error('IDB_OPEN_FAIL')); };
    });
  }

  function txOp(storeName, mode, fn) {
    return new Promise(function (resolve, reject) {
      var tx = idb.transaction(storeName, mode);
      var store = tx.objectStore(storeName);
      var result;
      tx.oncomplete = function () { resolve(result); };
      tx.onerror = function () { reject(tx.error); };
      tx.onabort = function () { reject(tx.error); };
      result = fn(store);
    });
  }
  function idbPut(sub) {
    return txOp(STORE, 'readwrite', function (store) { store.put(sub); });
  }
  function idbDelete(id) {
    return txOp(STORE, 'readwrite', function (store) { store.delete(id); });
  }
  function idbGetAll() {
    return new Promise(function (resolve, reject) {
      var tx = idb.transaction(STORE, 'readonly');
      var req = tx.objectStore(STORE).getAll();
      tx.oncomplete = function () { resolve(req.result || []); };
      tx.onerror = function () { reject(tx.error); };
    });
  }

  /* 启动：打开库 → 迁移旧 localStorage 数据 → 全量载入内存 */
  function bootstrap() {
    if (booted) return Promise.resolve();
    return openDB().then(function (db) {
      idb = db;
      var old = read(KEY_SUBS, null);
      if (old && old.length) {
        return txOp(STORE, 'readwrite', function (store) {
          old.forEach(function (s) { store.put(s); });
        }).then(function () {
          try { localStorage.removeItem(KEY_SUBS); } catch (e) {}
        });
      }
    }).then(function () {
      return idbGetAll();
    }).then(function (list) {
      memSubs = list;
      booted = true;
    }).catch(function (err) {
      // IndexedDB 不可用时退化为纯内存模式（本次会话可用，刷新丢失）
      memSubs = read(KEY_SUBS, []);
      booted = true;
      if (err && err.message === 'NO_IDB') return;
      throw err;
    });
  }

  /* ---------- 作业：同步读（bootstrap 之后），异步写 ---------- */
  function getSubmissions() {
    return memSubs || [];
  }
  /* 从 IndexedDB 重新全量读取（多个标签页同时打开时，用于拿到别的标签写入的最新状态） */
  function reloadSubmissions() {
    return idbGetAll().then(function (list) { memSubs = list; return list; });
  }
  function getSubmission(id) {
    var list = memSubs || [];
    for (var i = 0; i < list.length; i++) {
      if (list[i].id === id) return list[i];
    }
    return null;
  }
  function addSubmission(sub) {
    memSubs.push(sub);
    return idbPut(sub).catch(function (e) {
      throw new Error('作业保存失败：' + (e && e.message ? e.message : '存储空间可能不足'));
    });
  }
  function deleteSubmission(id) {
    memSubs = memSubs.filter(function (s) { return s.id !== id; });
    return idbDelete(id);
  }
  function updateSubmission(id, patch) {
    var target = null;
    memSubs.forEach(function (s) {
      if (s.id !== id) return;
      for (var k in patch) {
        if (Object.prototype.hasOwnProperty.call(patch, k)) s[k] = patch[k];
      }
      target = s;
    });
    if (!target) return Promise.resolve(null);
    return idbPut(target).then(function () { return target; });
  }

  /* 批改结果写回：若该作业已被其他页面批完（aiStatus=done），绝不覆盖。
     防止同一台设备两个标签页同时批改同一份作业时互相冲掉结果。 */
  function finishSubmission(id, patch) {
    return new Promise(function (resolve, reject) {
      var tx = idb.transaction(STORE, 'readwrite');
      var store = tx.objectStore(STORE);
      var getReq = store.get(id);
      getReq.onsuccess = function () {
        var cur = getReq.result;
        if (!cur) { resolve(null); return; }
        if (cur.aiStatus === 'done') {
          // 同步内存缓存（可能是别的标签页刚写完的结果）
          memSubs.forEach(function (s, i) { if (s.id === id) memSubs[i] = cur; });
          resolve(cur);
          return;
        }
        for (var k in patch) {
          if (Object.prototype.hasOwnProperty.call(patch, k)) cur[k] = patch[k];
        }
        store.put(cur);
        memSubs.forEach(function (s) {
          if (s.id === id) {
            for (var k2 in patch) {
              if (Object.prototype.hasOwnProperty.call(patch, k2)) s[k2] = patch[k2];
            }
          }
        });
      };
      getReq.onerror = function () { reject(getReq.error); };
      tx.oncomplete = function () { resolve(getReq.result); };
      tx.onerror = function () { reject(tx.error); };
      tx.onabort = function () { reject(tx.error); };
    });
  }

  /* ---------- 图片压缩 ----------
   * 拍照照片通常 2~8MB，压缩后用于 AI 识别与本地留存。
   */
  function compressImage(file, maxEdge, quality) {
    maxEdge = maxEdge || 1000;
    quality = quality || 0.7;

    return new Promise(function (resolve, reject) {
      var reader = new FileReader();
      reader.onerror = function () { reject(new Error('图片读取失败，请重试')); };
      reader.onload = function (e) {
        var img = new Image();
        img.onerror = function () { reject(new Error('图片格式无法识别')); };
        img.onload = function () {
          var w = img.width, h = img.height;
          if (w > maxEdge || h > maxEdge) {
            if (w >= h) { h = Math.round(h * maxEdge / w); w = maxEdge; }
            else { w = Math.round(w * maxEdge / h); h = maxEdge; }
          }
          var canvas = document.createElement('canvas');
          canvas.width = w;
          canvas.height = h;
          var ctx = canvas.getContext('2d');
          ctx.fillStyle = '#ffffff';
          ctx.fillRect(0, 0, w, h);
          ctx.drawImage(img, 0, 0, w, h);
          try {
            resolve(canvas.toDataURL('image/jpeg', quality));
          } catch (err) {
            reject(new Error('图片压缩失败'));
          }
        };
        img.src = e.target.result;
      };
      reader.readAsDataURL(file);
    });
  }

  /* 对已有的 dataURL 再次缩小（需要时重试） */
  function recompressDataURL(dataURL, maxEdge, quality) {
    return new Promise(function (resolve, reject) {
      var img = new Image();
      img.onerror = function () { reject(new Error('图片处理失败')); };
      img.onload = function () {
        var w = img.width, h = img.height;
        if (w > maxEdge || h > maxEdge) {
          if (w >= h) { h = Math.round(h * maxEdge / w); w = maxEdge; }
          else { w = Math.round(w * maxEdge / h); h = maxEdge; }
        }
        var canvas = document.createElement('canvas');
        canvas.width = w;
        canvas.height = h;
        var ctx = canvas.getContext('2d');
        ctx.fillStyle = '#fff';
        ctx.fillRect(0, 0, w, h);
        ctx.drawImage(img, 0, 0, w, h);
        try { resolve(canvas.toDataURL('image/jpeg', quality)); }
        catch (e) { reject(new Error('图片压缩失败')); }
      };
      img.src = dataURL;
    });
  }

  global.Store = {
    bootstrap: bootstrap,
    getStudentName: getStudentName,
    setStudentName: setStudentName,
    getStudentClass: getStudentClass,
    setStudentClass: setStudentClass,
    getAIConfig: getAIConfig,
    setAIConfig: setAIConfig,
    getSubmissions: getSubmissions,
    reloadSubmissions: reloadSubmissions,
    addSubmission: addSubmission,
    deleteSubmission: deleteSubmission,
    getSubmission: getSubmission,
    updateSubmission: updateSubmission,
    finishSubmission: finishSubmission,
    compressImage: compressImage,
    recompressDataURL: recompressDataURL
  };
})(window);
