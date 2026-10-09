/* =========================================================
 * app.js —— 页面交互与渲染
 * 学生端（student.html）：作业要求 / 拍照上传 / 我的记录
 * 教师端（teacher.html）：作业批改（编辑 AI 评语）/ 批改记录
 * 入口页（index.html）：纯静态分流，不加载本脚本
 * ========================================================= */
(function () {
  'use strict';

  /* 当前页面角色：由 <body data-app="student|teacher"> 声明 */
  var ROLE = document.body.getAttribute('data-app');

  function $(s, root) { return (root || document).querySelector(s); }

  /* ---------- 小工具 ---------- */
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function uid() {
    return 's' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  }

  function fmtTime(t) {
    var d = new Date(t);
    function p(n) { return String(n).padStart(2, '0'); }
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) +
      ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
  }

  function emptyHTML(t1, t2) {
    return '<div class="empty">' +
      '<svg viewBox="0 0 24 24" width="46" height="46"><path d="M20 17c-3-2.2-6-2.2-8 0-2-2.2-5-2.2-8 0" fill="none" stroke="#9fb5a1" stroke-width="1.5" stroke-linecap="round"/><path d="M12 4v13M8 7c0-2 2-3 4-3s4 1 4 3" fill="none" stroke="#9fb5a1" stroke-width="1.5" stroke-linecap="round"/></svg>' +
      '<div class="e1">' + esc(t1) + '</div><div class="e2">' + esc(t2 || '') + '</div></div>';
  }

  var toastTimer = null;
  function toast(msg) {
    var t = $('#toast');
    t.textContent = msg;
    t.classList.remove('hidden');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.classList.add('hidden'); }, 2200);
  }

  /* ---------- 评价只读视图 ---------- */
  function evalHTML(ev) {
    var dims = ev.dimensions.map(function (d) {
      var compTag = (d.key === 'layout' && d.composition)
        ? '<span class="comp-tag">' + esc(d.composition) + '</span>'
        : '';
      return '<div class="dim-row">' +
        '<div class="dim-name">' + esc(d.name) + '<small>权重 ' + d.weight + '%</small></div>' +
        '<div class="dim-main">' +
        '<div class="dim-level-line">' +
        '<span class="level ' + AI.levelClass(d.level) + '">' + esc(d.level) + '</span>' +
        '<span style="font-size:12px;color:var(--ink-3)">' + d.score + ' 分</span>' +
        compTag +
        '</div>' +
        '<div class="dim-comment">' + esc(d.comment) + '</div>' +
        '</div></div>';
    }).join('');

    var sug = ev.suggestions.map(function (s) {
      return '<li>' + esc(s) + '</li>';
    }).join('');

    return '<div class="eval-block"><h4>各维度评价结论</h4>' + dims + '</div>' +
      '<div class="eval-block"><h4>画面可修改 / 可添加的地方</h4>' +
      '<ul class="suggest-list">' + sug + '</ul></div>' +
      '<div class="total-box">' +
      '<div class="total-score"><div class="num">' + ev.totalScore + '<small> 分</small></div>' +
      '<div class="lab">总分</div></div>' +
      '<div class="total-text"><div class="lv-wrap">' +
      '<span class="level ' + AI.levelClass(ev.overallLevel) + '">' + esc(ev.overallLevel) + '</span>' +
      '</div>' + esc(ev.overallComment) + '</div></div>';
  }

  /* 当前端的视图刷新函数：由各自 init 注册（渲染函数定义在 init 内部，顶层访问不到） */
  var refreshStudentView = null;
  var refreshTeacherView = null;

  /* 批改完成后：刷新当前端的视图（另一端此刻未打开，无需处理） */
  function refreshAfterGrade() {
    if (ROLE === 'teacher' && refreshTeacherView) refreshTeacherView();
    else if (ROLE === 'student' && refreshStudentView) refreshStudentView();
  }

  function runGrading(sub) {
    AI.grade(sub.image, Store.getAIConfig()).then(function (ev) {
      Store.updateSubmission(sub.id, { aiStatus: 'done', ai: ev, working: null });
    }, function (err) {
      Store.updateSubmission(sub.id, { aiStatus: 'error', aiError: err.message || '批改失败' });
    }).then(refreshAfterGrade);
  }

  /* =========================================================
   * 学生端
   * ========================================================= */
  function initStudent() {

    /* 评价标准折叠区 */
    function renderRubric() {
      var html = AI.RUBRIC.map(function (r, i) {
        var compLine = '';
        if (i === 2) {
          compLine = '<p class="comp-line"><b>构图识别：</b>评价时会先写明作品使用的构图类型。课堂基础版式「' +
            AI.BASIC_COMPOSITIONS.join(' · ') +
            '」；拓展构图「' + AI.EXTENDED_COMPOSITIONS.join(' · ') + '」。</p>';
        }
        return '<div class="rubric-item"><h4>' +
          ['一', '二', '三', '四', '五'][i] + '、' + esc(r.name) +
          '<em>权重 ' + r.weight + '</em></h4>' +
          '<p style="font-size:12px;color:var(--ink-3);margin-bottom:6px">' + esc(r.desc) + '</p>' +
          '<ul>' +
          '<li><b>优秀</b>' + esc(r.A) + '</li>' +
          '<li><b>良好</b>' + esc(r.B) + '</li>' +
          '<li><b>合格</b>' + esc(r.C) + '</li>' +
          '<li><b>待改进</b>' + esc(r.D) + '</li>' +
          '</ul>' + compLine + '</div>';
      }).join('');
      $('#rubric-table').innerHTML = html;
    }

    /* 标签页 */
    document.querySelectorAll('[data-stab]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        document.querySelectorAll('[data-stab]').forEach(function (b) { b.classList.toggle('active', b === btn); });
        var key = btn.dataset.stab;
        $('#stab-submit').classList.toggle('hidden', key !== 'submit');
        $('#stab-records').classList.toggle('hidden', key !== 'records');
        if (key === 'records') renderStudentRecords();
      });
    });

    /* 上传作品 */
    var pendingImage = '';

    function setPreview(dataUrl) {
      pendingImage = dataUrl;
      if (dataUrl) {
        $('#preview-img').src = dataUrl;
        $('#upload-empty').classList.add('hidden');
        $('#upload-preview').classList.remove('hidden');
        $('#btn-submit').disabled = false;
      } else {
        $('#upload-empty').classList.remove('hidden');
        $('#upload-preview').classList.add('hidden');
        $('#btn-submit').disabled = true;
      }
    }

    function handleFile(file) {
      if (!file) return;
      if (!/image\//.test(file.type)) { toast('请选择图片文件'); return; }
      Store.compressImage(file).then(setPreview).catch(function (err) {
        toast(err.message || '图片处理失败');
      });
    }

    $('#input-camera').addEventListener('change', function (e) {
      handleFile(e.target.files[0]);
      e.target.value = '';
    });
    $('#input-album').addEventListener('change', function (e) {
      handleFile(e.target.files[0]);
      e.target.value = '';
    });
    $('#btn-camera').addEventListener('click', function () { $('#input-camera').click(); });
    $('#btn-album').addEventListener('click', function () { $('#input-album').click(); });
    $('#remove-img').addEventListener('click', function () {
      setPreview('');
      // 直接打开相册，改完马上能重选
      $('#input-album').click();
    });

    $('#btn-submit').addEventListener('click', function () {
      if (!pendingImage) return;
      var name = Store.getStudentName();
      if (!name) { openNameModal(); return; }
      var btn = $('#btn-submit');
      btn.disabled = true;

      function buildSub(image) {
        return {
          id: uid(),
          studentName: name,
          image: image,
          submittedAt: Date.now(),
          aiStatus: 'grading',
          aiError: '',
          ai: null,
          working: null,
          publishedAt: null
        };
      }

      // IndexedDB 容量足以存整班作业；极端情况下保存失败再缩小一档重试
      var sub = buildSub(pendingImage);
      Store.addSubmission(sub).then(function () { return sub; }, function () {
        return Store.recompressDataURL(pendingImage, 700, 0.62).then(function (smaller) {
          sub.image = smaller;
          return Store.addSubmission(sub).then(function () { return sub; });
        });
      }).then(function (saved) {
        setPreview('');
        toast('提交成功，AI 正在批改…');

        // 切到“我的记录”
        document.querySelectorAll('[data-stab]').forEach(function (b) {
          b.classList.toggle('active', b.dataset.stab === 'records');
        });
        $('#stab-submit').classList.add('hidden');
        $('#stab-records').classList.remove('hidden');
        renderStudentRecords();

        runGrading(saved);
      }, function () {
        btn.disabled = false;
        toast('作业保存失败，请重试');
      });
    });

    /* 我的记录（只展示已发布评语） */
    function renderStudentRecords() {
      var name = Store.getStudentName();
      var box = $('#student-records-list');
      var list = Store.getSubmissions()
        .filter(function (s) { return s.studentName === name; })
        .sort(function (a, b) { return b.submittedAt - a.submittedAt; });

      if (!list.length) {
        box.innerHTML = emptyHTML('还没有提交过作业', '去「作业提交」页上传你的本草画册内页吧');
        return;
      }

      box.innerHTML = list.map(function (s) {
        var badge, body, toggle;

        if (s.aiStatus === 'grading') {
          badge = '<span class="badge grading"><span class="dot-flash">AI 批改中…</span></span>';
          body = '<div class="status-note"><span class="badge grading">●</span>AI 正在分析画面，请稍等片刻…</div>';
          toggle = '查看状态';
        } else if (s.aiStatus === 'error') {
          badge = '<span class="badge error">批改遇到问题</span>';
          body = '<div class="status-note"><span class="badge error">●</span>本次批改未成功，老师会重新发起批改，请耐心等待。</div>';
          toggle = '查看状态';
        } else if (!s.publishedAt) {
          badge = '<span class="badge reviewing">教师审阅中</span>';
          body = '<div class="status-note"><span class="badge reviewing">●</span>AI 已完成批改，老师确认并发布评语后即可在此查看点评。</div>';
          toggle = '查看状态';
        } else {
          badge = '<span class="badge published">已发布</span>';
          body = '<img class="big-img" src="' + s.image + '" alt="作品照片">' + evalHTML(s.working);
          toggle = '查看点评';
        }

        return '<div class="record-card" data-id="' + s.id + '">' +
          '<div class="record-head">' +
          '<img class="record-thumb" src="' + s.image + '" alt="缩略图">' +
          '<div class="record-meta"><div class="t1">本草画册内页</div>' +
          '<div class="t2">提交于 ' + fmtTime(s.submittedAt) + '</div></div>' +
          badge +
          '<button class="record-toggle" data-toggle>' + toggle + '</button>' +
          '</div>' +
          '<div class="record-body hidden">' + body + '</div>' +
          '</div>';
      }).join('');
    }

    /* 记录卡片展开/收起 */
    $('#student-records-list').addEventListener('click', function (e) {
      var btn = e.target.closest('[data-toggle]');
      if (!btn) return;
      var card = btn.closest('.record-card');
      var body = $('.record-body', card);
      var open = body.classList.toggle('hidden') === false;
      card.classList.toggle('open', open);
      if (open) {
        btn.textContent = '收起';
      } else {
        var sub = Store.getSubmission(card.dataset.id);
        btn.textContent = (sub && sub.publishedAt) ? '查看点评' : '查看状态';
      }
    });

    /* 学生姓名弹窗 */
    function openNameModal() {
      var modal = $('#modal-name');
      var input = $('#input-name');
      input.value = Store.getStudentName();
      modal.classList.remove('hidden');
      setTimeout(function () { input.focus(); }, 50);
    }

    function confirmName() {
      var v = $('#input-name').value.trim();
      if (!v) { toast('请输入姓名'); return; }
      Store.setStudentName(v);
      $('#modal-name').classList.add('hidden');
      enterStudent();
    }

    $('#btn-name-ok').addEventListener('click', confirmName);
    $('#input-name').addEventListener('keydown', function (e) {
      if (e.key === 'Enter') confirmName();
    });

    /* 进入学生端：显示姓名、加载记录 */
    function enterStudent() {
      $('#student-name-label').textContent = Store.getStudentName();
      renderStudentRecords();
    }

    renderRubric();

    // 注册给顶层批改流程使用
    refreshStudentView = function () { renderStudentRecords(); };

    // 未登记姓名：先弹窗；已登记：直接进入
    if (!Store.getStudentName()) openNameModal();
    else enterStudent();
  }

  /* =========================================================
   * 教师端
   * ========================================================= */
  function initTeacher() {

    /* 标签页 */
    document.querySelectorAll('[data-ttab]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        document.querySelectorAll('[data-ttab]').forEach(function (b) { b.classList.toggle('active', b === btn); });
        var key = btn.dataset.ttab;
        $('#ttab-pending').classList.toggle('hidden', key !== 'pending');
        $('#ttab-records').classList.toggle('hidden', key !== 'records');
        if (key === 'pending') renderTeacherPending();
        if (key === 'records') renderTeacherRecords();
      });
    });

    function ensureWorking(sub) {
      if (!sub.working && sub.ai) {
        sub.working = JSON.parse(JSON.stringify(sub.ai));
      }
      return sub.working;
    }

    function levelOptions(selected) {
      return AI.LEVELS.map(function (l) {
        return '<option value="' + l + '"' + (l === selected ? ' selected' : '') + '>' + l + '</option>';
      }).join('');
    }

    /* 构图类型下拉：术语来自 AI 层单一真源（4 基础 + 6 拓展 + 无明确版式） */
    function compositionOptions(selected) {
      function opts(list) {
        return list.map(function (n) {
          return '<option value="' + esc(n) + '"' + (n === selected ? ' selected' : '') + '>' + esc(n) + '</option>';
        }).join('');
      }
      return '<option value="">— 请选择构图版式 —</option>' +
        '<optgroup label="课堂基础版式">' + opts(AI.BASIC_COMPOSITIONS) + '</optgroup>' +
        '<optgroup label="拓展构图">' + opts(AI.EXTENDED_COMPOSITIONS) + '</optgroup>' +
        '<option value="' + esc(AI.COMPOSITION_NONE) + '"' +
        (selected === AI.COMPOSITION_NONE ? ' selected' : '') + '>' + esc(AI.COMPOSITION_NONE) + '</option>';
    }

    function gradeCardHTML(sub) {
      var w = ensureWorking(sub);

      if (sub.aiStatus === 'grading') {
        return '<div class="grade-card" data-id="' + sub.id + '"><div class="grade-head">' +
          '<img class="record-thumb" src="' + sub.image + '">' +
          '<div class="gm"><div class="n">' + esc(sub.studentName) + '</div>' +
          '<div class="t">提交于 ' + fmtTime(sub.submittedAt) + '</div></div>' +
          '<span class="badge grading"><span class="dot-flash">AI 批改中…</span></span></div></div>';
      }

      if (sub.aiStatus === 'error') {
        return '<div class="grade-card" data-id="' + sub.id + '"><div class="grade-head">' +
          '<img class="record-thumb" src="' + sub.image + '">' +
          '<div class="gm"><div class="n">' + esc(sub.studentName) + '</div>' +
          '<div class="t">提交于 ' + fmtTime(sub.submittedAt) + '</div></div>' +
          '<span class="badge error">批改失败</span></div>' +
          '<div class="error-box"><span>' + esc(sub.aiError || '未知错误') + '</span>' +
          '<button class="btn btn-outline btn-sm" data-action="retry">重新批改</button></div></div>';
      }

      var dimRows = w.dimensions.map(function (d) {
        var row = '<div class="dim-edit">' +
          '<div class="dn">' + esc(d.name) + '<small>权重 ' + d.weight + '%</small></div>' +
          '<div><select class="sel-input" data-action="dim-level" data-key="' + d.key + '">' +
          levelOptions(d.level) + '</select>' +
          '<div class="dim-score-cell"><b data-score-for="' + d.key + '">' + d.score + '</b> 分</div></div>' +
          '<textarea class="area-input" rows="2" data-action="dim-comment" data-key="' + d.key + '">' +
          esc(d.comment) + '</textarea>' +
          '</div>';

        // 构图维度额外一行：构图类型（旧数据无 composition 时默认空，由教师补选）
        if (d.key === 'layout') {
          row += '<div class="dim-edit composition-row">' +
            '<div class="dn">构图类型<small>须与课件术语一致</small></div>' +
            '<div style="grid-column: span 2"><select class="sel-input" data-action="composition">' +
            compositionOptions(d.composition || '') + '</select></div></div>';
        }
        return row;
      }).join('');

      var sugRows = w.suggestions.map(function (s, i) {
        return '<div class="suggest-edit-row">' +
          '<span class="idx">' + (i + 1) + '</span>' +
          '<textarea class="area-input" rows="2" data-action="suggestion" data-idx="' + i + '">' + esc(s) + '</textarea>' +
          '<button class="suggest-del" data-action="suggestion-del" data-idx="' + i + '" title="删除此条">✕</button>' +
          '</div>';
      }).join('');

      return '<div class="grade-card" data-id="' + sub.id + '">' +
        '<div class="grade-head">' +
        '<img class="record-thumb" src="' + sub.image + '">' +
        '<div class="gm"><div class="n">' + esc(sub.studentName) + '</div>' +
        '<div class="t">提交于 ' + fmtTime(sub.submittedAt) + '</div></div>' +
        '<span class="badge reviewing">待发布</span></div>' +
        '<div class="grade-grid">' +
        '<div class="grade-img"><img src="' + sub.image + '" alt="学生作品"></div>' +
        '<div class="grade-form">' +

        '<div class="edit-section"><h4>各维度评价结论<span class="ai-tag">AI 生成 · 可直接修改</span></h4>' +
        dimRows + '</div>' +

        '<div class="edit-section"><h4>画面可修改 / 可添加的地方</h4>' +
        sugRows +
        '<button class="add-suggest" data-action="suggestion-add">＋ 添加一条建议</button></div>' +

        '<div class="edit-section"><h4>总分与整体评价</h4>' +
        '<div class="total-edit">' +
        '<div class="total-edit-row1">' +
        '<span class="big-score"><span data-total-score>' + w.totalScore + '</span> 分</span>' +
        '<select class="sel-input" data-action="overall-level">' + levelOptions(w.overallLevel) + '</select>' +
        '</div>' +
        '<textarea class="area-input" rows="3" data-action="overall-comment">' + esc(w.overallComment) + '</textarea>' +
        '</div></div>' +

        '<div class="grade-actions">' +
        '<button class="btn btn-ghost btn-sm" data-action="reset-ai">恢复 AI 原文</button>' +
        '<button class="btn btn-outline btn-sm" data-action="save">保存修改</button>' +
        '<button class="btn btn-primary btn-sm" data-action="publish">确认并发布给学生</button>' +
        '</div>' +

        '</div></div></div>';
    }

    function renderTeacherPending() {
      var box = $('#teacher-pending-list');
      var list = Store.getSubmissions()
        .filter(function (s) { return !s.publishedAt; })
        .sort(function (a, b) { return a.submittedAt - b.submittedAt; });

      var badge = $('#pending-count');
      badge.textContent = list.length;
      badge.classList.toggle('hidden', list.length === 0);

      if (!list.length) {
        box.innerHTML = emptyHTML('暂时没有待批改的作业', '学生提交后会自动出现在这里');
        return;
      }
      box.innerHTML = list.map(gradeCardHTML).join('');
    }

    /* 批改卡：文本编辑实时写入并立即持久化（否则重新读取会丢失改动） */
    $('#teacher-pending-list').addEventListener('input', function (e) {
      var t = e.target;
      var card = t.closest('.grade-card');
      if (!card) return;
      var sub = Store.getSubmission(card.dataset.id);
      var w = ensureWorking(sub);
      var changed = false;
      var action = t.dataset.action;

      if (action === 'dim-comment') {
        var d = w.dimensions.filter(function (x) { return x.key === t.dataset.key; })[0];
        if (d) { d.comment = t.value; changed = true; }
      } else if (action === 'suggestion') {
        w.suggestions[Number(t.dataset.idx)] = t.value;
        changed = true;
      } else if (action === 'overall-comment') {
        w.overallComment = t.value;
        changed = true;
      }
      if (changed) Store.updateSubmission(card.dataset.id, { working: w });
    });

    /* 批改卡：下拉 */
    $('#teacher-pending-list').addEventListener('change', function (e) {
      var t = e.target;
      var card = t.closest('.grade-card');
      if (!card) return;
      var sub = Store.getSubmission(card.dataset.id);
      var w = ensureWorking(sub);

      if (t.dataset.action === 'dim-level') {
        var d = w.dimensions.filter(function (x) { return x.key === t.dataset.key; })[0];
        d.level = t.value;
        d.score = AI.LEVEL_SCORE[t.value];
        w.totalScore = AI.computeScore(w.dimensions);
        w.overallLevel = AI.levelFromScore(w.totalScore);
        Store.updateSubmission(card.dataset.id, { working: w });

        // 只刷新分数显示，不整体重绘以免打断编辑
        var cell = $('[data-score-for="' + d.key + '"]', card);
        if (cell) cell.textContent = d.score;
        $('[data-total-score]', card).textContent = w.totalScore;
        var ov = $('[data-action="overall-level"]', card);
        ov.value = w.overallLevel;
      } else if (t.dataset.action === 'composition') {
        var ld = w.dimensions.filter(function (x) { return x.key === 'layout'; })[0];
        ld.composition = t.value;
        Store.updateSubmission(card.dataset.id, { working: w });
      }
    });

    /* 批改卡：按钮 */
    $('#teacher-pending-list').addEventListener('click', function (e) {
      var t = e.target.closest('[data-action]');
      if (!t) return;
      var card = t.closest('.grade-card');
      var sub = card ? Store.getSubmission(card.dataset.id) : null;
      var action = t.dataset.action;

      if (action === 'retry') {
        var targetId = card.dataset.id;
        Store.updateSubmission(targetId, { aiStatus: 'grading', aiError: '' });
        var fresh = Store.getSubmission(targetId);
        renderTeacherPending();
        runGrading(fresh);
        return;
      }

      if (!sub) return;
      var w = ensureWorking(sub);

      if (action === 'suggestion-add') {
        w.suggestions.push('新的优化建议：');
        Store.updateSubmission(sub.id, { working: w });
        renderTeacherPending();
      } else if (action === 'suggestion-del') {
        w.suggestions.splice(Number(t.dataset.idx), 1);
        Store.updateSubmission(sub.id, { working: w });
        renderTeacherPending();
      } else if (action === 'reset-ai') {
        Store.updateSubmission(sub.id, { working: JSON.parse(JSON.stringify(sub.ai)) });
        renderTeacherPending();
        toast('已恢复为 AI 原始评价');
      } else if (action === 'save') {
        Store.updateSubmission(sub.id, { working: w });
        toast('修改已保存');
      } else if (action === 'publish') {
        w.suggestions = w.suggestions.map(function (s) { return String(s).trim(); }).filter(Boolean);
        if (!w.suggestions.length) { toast('请至少保留一条优化建议'); return; }
        Store.updateSubmission(sub.id, { working: w, publishedAt: Date.now() });
        toast('评语已发布给 ' + sub.studentName);
        renderTeacherPending();
        renderTeacherRecords();
      }
    });

    /* 批改记录（全部学生，只读，可搜索） */
    function renderTeacherRecords() {
      var q = $('#teacher-search').value.trim();
      var box = $('#teacher-records-list');
      var list = Store.getSubmissions()
        .filter(function (s) { return s.publishedAt; })
        .filter(function (s) { return !q || s.studentName.indexOf(q) >= 0; })
        .sort(function (a, b) { return b.publishedAt - a.publishedAt; });

      if (!list.length) {
        box.innerHTML = emptyHTML(
          q ? '没有找到匹配的学生记录' : '还没有已发布的批改记录',
          q ? '换个姓名试试' : '在「作业批改」中发布评语后会显示在这里'
        );
        return;
      }

      box.innerHTML = list.map(function (s) {
        return '<div class="grade-card" data-id="' + s.id + '"><div class="grade-head">' +
          '<img class="record-thumb" src="' + s.image + '">' +
          '<div class="gm"><div class="n">' + esc(s.studentName) + '</div>' +
          '<div class="t">提交 ' + fmtTime(s.submittedAt) + ' ｜ 发布 ' + fmtTime(s.publishedAt) + '</div></div>' +
          '<span class="badge published">已发布</span>' +
          '<button class="link-btn danger record-del" data-action="record-del">删除</button></div>' +
          '<div class="grade-grid"><div class="grade-img"><img src="' + s.image + '" alt="学生作品"></div>' +
          '<div class="grade-form">' + evalHTML(s.working) + '</div></div></div>';
      }).join('');
    }

    $('#teacher-search').addEventListener('input', renderTeacherRecords);

    // 删除记录（同时释放本地存储空间）
    $('#teacher-records-list').addEventListener('click', function (e) {
      var btn = e.target.closest('[data-action="record-del"]');
      if (!btn) return;
      var card = btn.closest('.grade-card');
      var sub = Store.getSubmission(card.dataset.id);
      if (!sub) return;
      if (window.confirm('确定删除 ' + sub.studentName + ' 的这份作业和评语吗？删除后无法恢复。')) {
        Store.deleteSubmission(sub.id);
        renderTeacherRecords();
        toast('已删除');
      }
    });

    /* AI 设置弹窗 */
    var draftMode = 'mock';

    function openSettings() {
      var cfg = Store.getAIConfig();
      draftMode = cfg.mode;
      $('.seg-btn[data-mode="mock"]').classList.toggle('active', cfg.mode === 'mock');
      $('.seg-btn[data-mode="real"]').classList.toggle('active', cfg.mode === 'real');
      $('#real-settings').classList.toggle('hidden', cfg.mode !== 'real');
      $('#select-provider').value = cfg.provider;
      $('#input-endpoint').value = cfg.endpoint;
      $('#input-model').value = cfg.model;
      $('#input-apikey').value = cfg.apiKey;
      $('#modal-settings').classList.remove('hidden');
    }

    $('#btn-settings').addEventListener('click', openSettings);
    $('#btn-settings-cancel').addEventListener('click', function () {
      $('#modal-settings').classList.add('hidden');
    });

    document.querySelectorAll('.seg-btn[data-mode]').forEach(function (b) {
      b.addEventListener('click', function () {
        draftMode = b.dataset.mode;
        $('.seg-btn[data-mode="mock"]').classList.toggle('active', draftMode === 'mock');
        $('.seg-btn[data-mode="real"]').classList.toggle('active', draftMode === 'real');
        $('#real-settings').classList.toggle('hidden', draftMode !== 'real');
      });
    });

    $('#select-provider').addEventListener('change', function () {
      var p = AI.PROVIDERS[this.value];
      if (p) {
        $('#input-endpoint').value = p.endpoint || '';
        $('#input-model').value = p.models && p.models[0] ? p.models[0] : '';
        if (this.value === 'doubao') $('#input-model').placeholder = '填写推理接入点 ID，如 doubao-xxxx-vision-xxxxx';
      }
    });

    $('#btn-settings-save').addEventListener('click', function () {
      var cfg = {
        mode: draftMode,
        provider: $('#select-provider').value,
        endpoint: $('#input-endpoint').value.trim(),
        model: $('#input-model').value.trim(),
        apiKey: $('#input-apikey').value.trim()
      };

      if (cfg.mode === 'real') {
        if (!cfg.apiKey) { toast('请填写 API Key'); return; }
        if (!cfg.endpoint) { toast('请填写接口地址'); return; }
        if (!cfg.model) { toast('请填写模型名称'); return; }
      }

      Store.setAIConfig(cfg);
      $('#modal-settings').classList.add('hidden');
      toast(cfg.mode === 'real' ? '已切换为真实 AI 批改' : '已保存：模拟批改模式');
    });

    // 注册给顶层批改流程使用（含“重新批改”完成后的界面刷新）
    refreshTeacherView = function () {
      renderTeacherPending();
      renderTeacherRecords();
    };
    refreshTeacherView();
  }

  /* =========================================================
   * 公共初始化
   * ========================================================= */
  function recoverInterrupted() {
    // 刷新/重新打开页面后，批改中的任务视为中断（教师可重新批改）
    Store.getSubmissions().forEach(function (s) {
      if (s.aiStatus === 'grading') {
        Store.updateSubmission(s.id, {
          aiStatus: 'error',
          aiError: '批改中断（页面被关闭或刷新），请重新批改'
        });
      }
    });
  }

  // 先打开本地存储（含旧数据迁移），再启动页面
  Store.bootstrap().then(function () {
    recoverInterrupted();
    if (ROLE === 'student') initStudent();
    else if (ROLE === 'teacher') initTeacher();
  }).catch(function (err) {
    document.body.insertAdjacentHTML('beforeend',
      '<div style="padding:24px;color:#b04a3a">本地存储无法使用：' +
      esc(err && err.message ? err.message : String(err)) + '</div>');
  });
})();
