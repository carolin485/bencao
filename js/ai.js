/* =========================================================
 * ai.js —— AI 批改适配层
 * ① 模拟批改：无需 Key，按评价标准生成结构化评价，供演示
 * ② 真实批改：调用 OpenAI 兼容的视觉大模型（智谱 / 千问 / 豆包…）
 * 统一输出：
 * {
 *   dimensions: [{key,name,weight,level,score,comment}],
 *   suggestions: [string],
 *   totalScore: number, overallLevel, overallComment
 * }
 * ========================================================= */
(function (global) {
  'use strict';

  var LEVELS = ['优秀', '良好', '合格', '待改进'];
  var LEVEL_SCORE = { '优秀': 95, '良好': 82, '合格': 67, '待改进': 50 };

  /* 五个维度（顺序即输出顺序，与 AI 约定一致） */
  var DIMENSIONS = [
    { key: 'shape', name: '写生造型', weight: 30 },
    { key: 'technique', name: '线描色彩技法', weight: 20 },
    { key: 'layout', name: '图文排版构图', weight: 20 },
    { key: 'knowledge', name: '本草知识文本', weight: 15 },
    { key: 'creativity', name: '作品完整度与创意', weight: 15 }
  ];

  /* ---------- 构图版式术语（与课件一致，禁止自造名词）· 单一真源 ---------- */
  var COMPOSITION_NONE = '未使用明确的构图版式';
  var BASIC_COMPOSITIONS = ['上下式', '对角式', '左右式', '中心发散式'];
  var EXTENDED_COMPOSITIONS = ['居中构图', '四角构图', '对称构图', 'S形曲线构图', '散点构图', '包围式构图'];

  /* 服务商预设 */
  var PROVIDERS = {
    zhipu: {
      endpoint: 'https://open.bigmodel.cn/api/paas/v4/chat/completions',
      models: ['glm-4.6v-flash', 'glm-4.1v-thinking-flash', 'glm-4v-flash']
    },
    qwen: {
      endpoint: 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions',
      models: ['qwen-vl-plus', 'qwen-vl-max']
    },
    doubao: {
      endpoint: 'https://ark.cn-beijing.volces.com/api/v3/chat/completions',
      models: [] // 火山方舟使用「推理接入点 ID」，需自行填写
    },
    custom: { endpoint: '', models: [] }
  };

  /* ---------- 分数计算 ---------- */
  function computeScore(dimensions) {
    var sum = 0;
    dimensions.forEach(function (d) {
      sum += (LEVEL_SCORE[d.level] || 0) * d.weight / 100;
    });
    return Math.round(sum);
  }

  function levelFromScore(score) {
    if (score >= 90) return '优秀';
    if (score >= 75) return '良好';
    if (score >= 60) return '合格';
    return '待改进';
  }

  function levelClass(level) {
    var i = LEVELS.indexOf(level);
    return ['level-a', 'level-b', 'level-c', 'level-d'][i] || 'level-c';
  }

  /* =========================================================
   * 评价标准（学生端展示 + AI prompt 共用）
   * ========================================================= */
  var RUBRIC = [
    {
      name: '观察与写生造型', weight: '30%',
      desc: '考查对本草植物形态、叶片、茎干、遮挡翻转关系的观察表现',
      A: '能抓住中草药典型外形特征，表现叶片前后遮挡、翻转姿态；茎、叶形态自然生动，没有僵硬对称；体现实地观察的结果，造型完整。',
      B: '能够表现本草主要外形特征；大部分叶片形态准确，少量遮挡关系没有表现；整体造型比较自然。',
      C: '能画出植物大体外形，可看出是什么草药；细节缺失较多，叶片、茎干简单概括。',
      D: '植物形态辨认困难，完全没有表现本草基本外形特征。'
    },
    {
      name: '线描与淡彩技法表现', weight: '20%',
      desc: '考查勾线质量、淡彩上色效果，本课所学线描、淡彩技能落实',
      A: '线条流畅有轻重变化；淡彩颜色清淡通透，先浅后深，不遮盖轮廓线；色彩贴合植物真实色调。',
      B: '线条整体流畅，少量涂改；淡彩上色基本清淡，局部略重，轮廓线基本保留。',
      C: '线条能完成物体轮廓；上色完成，部分区域颜色过重，少量盖住勾线。',
      D: '线条杂乱难以辨认；未完成上色或涂色大面积糊掉，完全破坏线描轮廓。'
    },
    {
      name: '画册排版与构图', weight: '20%',
      desc: '考查画面构图、图文位置、主次关系，画册内页版式设计',
      A: '构图饱满舒服，本草绘画为画面主体；图画占版面主要位置，文字位置合理；图文主次分明，可搭配简约装饰，版面干净美观。',
      B: '构图比较完整，绘画主体突出；图文位置基本合适，少量文字挤压画面空间。',
      C: '完成版面排布，图画和文字都有放置；图文比例稍有失衡，但可以作为画册内页使用。',
      D: '构图拥挤或画面太空；文字、图画互相重叠，版面混乱，不具备画册内页效果。'
    },
    {
      name: '本草知识文本内容', weight: '15%',
      desc: '考查本草名称、功效等科普信息，对本草文化认知',
      A: '准确标注中草药名称；功效介绍简洁正确；文字书写工整，符合本草记录的特点。',
      B: '写对本草名称；功效信息基本正确，书写较工整。',
      C: '有本草名称，功效内容简单，文字潦草。',
      D: '缺少植物名称，无任何本草文字介绍。'
    },
    {
      name: '作品完整度与文化创意', weight: '15%',
      desc: '考查整页作业完成度、格物致知观察精神、本草文化理解',
      A: '整页作业全部完成；有自己观察思考的小创意；能体现“本草记录者”意识，理解本草图谱科学+艺术双重特点。',
      B: '作业全部完成；有简单自己的想法，理解本草记录的意义。',
      C: '基本完成课堂作业，没有明显创意，但完成基础任务。',
      D: '作业大面积未完成，没有达到课堂基础创作要求。'
    }
  ];

  /* =========================================================
   * 模拟批改（演示用）
   * ========================================================= */

  /* 构图版式定义：每种构图的四级评价结论（开头必须写明构图名称）+ 专属优化建议 */
  var COMPOSITION_DEFS = [
    {
      name: '上下式', basic: true,
      comments: {
        '优秀': '画面采用上下式构图，上方本草绘画、下方文字介绍分区清晰，图文主次分明，区域分割合理。',
        '良好': '画面采用上下式构图，上下分区基本清楚，绘画主体突出，少量文字与图画间距偏近。',
        '合格': '画面采用上下式构图，图文上下摆放可以辨认，但两区域比例失衡，分割不够明确。',
        '待改进': '虽有上下摆放的意图，但分区混乱、图文挤在一起，没有用好上下式构图的表达逻辑。'
      },
      suggestions: [
        '上下两个区域可以拉大间距，或用一条细线、淡色块明确分割图文。',
        '上方本草绘画可适当放大占稳主体，下方文字集中对齐，不要越界挤入画面。'
      ]
    },
    {
      name: '对角式', basic: true,
      comments: {
        '优秀': '画面采用对角式构图，本草沿对角线舒展生长，对角方向的文字与留白呼应，动势自然。',
        '良好': '画面采用对角式构图，主体沿对角方向排布基本明确，对角另一侧略显空、呼应不足。',
        '合格': '画面采用对角式构图，能看出对角走向，但植物与文字没有沿对角关系摆放，动势偏弱。',
        '待改进': '植物和文字随意摆放，对角式构图的斜向动势没有建立，画面缺少方向感。'
      },
      suggestions: [
        '可以让本草的主茎沿画面一条对角线生长，增强斜向动势。',
        '在对角的另一端安排标题或少量文字，与主体形成对角呼应。'
      ]
    },
    {
      name: '左右式', basic: true,
      comments: {
        '优秀': '画面采用左右式构图，一侧本草绘画、一侧文字介绍，图文分区明确、主次清楚。',
        '良好': '画面采用左右式构图，左右分区基本合理，文字一侧略显拥挤，间距可以再宽松。',
        '合格': '画面采用左右式构图，图文各占一边，但两侧比例失衡，绘画主体不够突出。',
        '待改进': '左右分区没有建立，文字压到植物一侧、互相重叠，不符合左右式构图的表达逻辑。'
      },
      suggestions: [
        '左右两区间留出明显间距，文字集中到一侧并对齐排列。',
        '绘画一侧放大本草形象成为视觉重心，避免图文各占一半、主次不分。'
      ]
    },
    {
      name: '中心发散式', basic: true,
      comments: {
        '优秀': '画面采用中心发散式构图，本草位于视觉中心，茎叶与文字围绕主体舒展排布，聚散得当。',
        '良好': '画面采用中心发散式构图，主体基本居中突出，部分文字离主体过近，围绕关系可以更清楚。',
        '合格': '画面采用中心发散式构图，植物大体在中心，但文字摆放零散，没有形成围绕主体的秩序。',
        '待改进': '中心主体不突出，文字与叶片互相遮挡，中心发散式的聚散关系没有建立。'
      },
      suggestions: [
        '保持本草在画面正中心，文字围绕四周排布，不要遮挡中心植物主体。',
        '茎叶可以从中心向四周舒展，注意长短错落，避免放射得过于僵硬。'
      ]
    },
    {
      name: '居中构图', basic: false,
      comments: {
        '优秀': '画面采用居中构图，本草端正居于画面中央、形象突出，文字安排在上下位置，稳重大方。',
        '良好': '画面采用居中构图，主体居中基本稳定，上下留白略有不均，文字安排可以再整齐。',
        '合格': '画面采用居中构图，植物大致居中，但文字偏移、四周留白不均衡，稳重感不足。',
        '待改进': '主体偏离中心、大小失衡，居中构图的端正感没有体现出来。'
      },
      suggestions: [
        '把本草形象放到画面正中，上下留白保持均等。',
        '标题与介绍文字沿中轴线对齐，增强居中构图的稳定感。'
      ]
    },
    {
      name: '四角构图', basic: false,
      comments: {
        '优秀': '画面采用四角构图，四角的文字与装饰呼应平衡，中间本草主体舒展，四角稳而不乱。',
        '良好': '画面采用四角构图，四角安排基本平衡，其中一角略重，整体仍能衬托中心主体。',
        '合格': '画面采用四角构图，只用到部分角落，四角轻重不均，画面有失衡感。',
        '待改进': '四角内容相互冲突或大面积空置，四角构图的平衡框架没有建立。'
      },
      suggestions: [
        '可在画面四角安排标题、功效或印章，注意四角分量均衡。',
        '四角内容要为中心本草服务，避免装饰过强、喧宾夺主。'
      ]
    },
    {
      name: '对称构图', basic: false,
      comments: {
        '优秀': '画面采用对称构图，本草与文字沿中轴线左右对称，秩序工整又不失自然。',
        '良好': '画面采用对称构图，对称关系基本成立，局部叶片的数量、位置略有不对称。',
        '合格': '画面采用对称构图，大体左右对应，但图文两侧分量不均，对称感偏弱。',
        '待改进': '两侧图文差别过大，对称构图的秩序感没有建立，画面显得随意。'
      },
      suggestions: [
        '沿画面中轴线，让左右两侧的叶片、文字数量与位置尽量对应。',
        '在工整对称中让叶片姿态略有变化，避免画面呆板。'
      ]
    },
    {
      name: 'S形曲线构图', basic: false,
      comments: {
        '优秀': '画面采用S形曲线构图，本草主茎婉转形成S形动势，图文随曲线起伏，节奏优美。',
        '良好': '画面采用S形曲线构图，主茎有一定曲线变化，S形动势还可以再明确一些。',
        '合格': '画面采用S形曲线构图，主茎略有弯曲，但未形成前后起伏的S形节奏。',
        '待改进': '主茎僵直、文字平铺，S形曲线构图的婉转动势没有体现。'
      },
      suggestions: [
        '可以让本草主茎画出明显的S形弯曲，先向上再转向，形成节奏。',
        '文字与叶片沿S形曲线两侧错落排布，增强画面的流动感。'
      ]
    },
    {
      name: '散点构图', basic: false,
      comments: {
        '优秀': '画面采用散点构图，多株本草或多枚叶片错落分布、聚散有致，图文穿插自然。',
        '良好': '画面采用散点构图，多个形象分布基本得当，局部疏密可以再调整。',
        '合格': '画面采用散点构图，形象分布偏平均或偏零散，主次关系不够清楚。',
        '待改进': '画面元素随意堆放、疏密无序，散点构图的节奏感没有建立。'
      },
      suggestions: [
        '安排元素时注意聚散对比，几株本草成组摆放，留出透气的空白。',
        '为散点画面确定一个稍大的主体形象，避免所有元素大小雷同。'
      ]
    },
    {
      name: '包围式构图', basic: false,
      comments: {
        '优秀': '画面采用包围式构图，文字与装饰沿四周边框环绕，中心本草突出，围而不堵。',
        '良好': '画面采用包围式构图，周边内容基本围合，一侧偏挤，中心主体仍然清楚。',
        '合格': '画面采用包围式构图，四周有文字环绕的意图，但边框不完整、图文比例失调。',
        '待改进': '周边文字过满、压住中心植物，包围式构图围得太堵，主体不透气。'
      },
      suggestions: [
        '文字与印章沿画面四周排布形成边框，把中心位置留给本草主体。',
        '四周边框不要排得太满，留出缺口和留白，避免画面闷堵。'
      ]
    },
    {
      name: COMPOSITION_NONE, basic: false,
      comments: {
        '合格': '图文都已呈现在画面中，如果能从课堂学过的上下式、左右式等版式中选定一种来安排，版面会更整体。',
        '待改进': '未使用明确的构图版式，图文随意堆放、互相干扰，画面缺少基本的版面规划。'
      },
      suggestions: [
        '建议先从课堂所学的上下式、左右式等版式中选定一种，把绘画与文字分区摆放。',
        '可以先用铅笔轻轻画出图文区域的分割线，再按规划好的版式调整内容位置。'
      ]
    }
  ];

  function isValidComposition(name) {
    if (name === COMPOSITION_NONE) return true;
    return BASIC_COMPOSITIONS.indexOf(name) >= 0 || EXTENDED_COMPOSITIONS.indexOf(name) >= 0;
  }

  function getCompositionDef(name) {
    for (var i = 0; i < COMPOSITION_DEFS.length; i++) {
      if (COMPOSITION_DEFS[i].name === name) return COMPOSITION_DEFS[i];
    }
    return null;
  }

  /* =========================================================
   * 画面观察器：把作品画到小 canvas，从像素中提取真实特征
   * ========================================================= */
  function loadSmallCanvas(dataURL, maxEdge) {
    return new Promise(function (resolve, reject) {
      var img = new Image();
      img.onload = function () {
        var w = img.width, h = img.height;
        if (w >= h) { if (w > maxEdge) { h = Math.round(h * maxEdge / w); w = maxEdge; } }
        else { if (h > maxEdge) { w = Math.round(w * maxEdge / h); h = maxEdge; } }
        var canvas = document.createElement('canvas');
        canvas.width = w; canvas.height = h;
        var ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0, w, h);
        var data;
        try { data = ctx.getImageData(0, 0, w, h).data; }
        catch (e) { reject(new Error('画面读取失败')); return; }
        resolve({ data: data, w: w, h: h });
      };
      img.onerror = function () { reject(new Error('画面读取失败')); };
      img.src = dataURL;
    });
  }

  function analyzeImage(dataURL) {
    return loadSmallCanvas(dataURL, 240).then(function (im) {
      var data = im.data, w = im.w, h = im.h, n = w * h;

      // ---- 细密网格：12 列 × 按宽高比取行数 ----
      var cols = 12;
      var rows = Math.max(10, Math.round(cols * h / w));
      var cw = w / cols, ch = h / rows, nb = cols * rows;
      var blocks = [], t;
      for (t = 0; t < nb; t++) {
        blocks.push({ x: t % cols, y: (t - t % cols) / cols,
                      n: 0, Ls: 0, Ss: 0, ink: 0, ink2: 0, col: 0, col2: 0, light: 0, redPx: 0,
                      histL: new Array(32).fill(0) });
      }

      var brightSum = 0;
      var green = 0, yellow = 0, red = 0, blue = 0, brown = 0;
      /* 像素色相掩码（造型细节分析用）：1绿 2黄 3红 4蓝 5棕 */
      var hueMask = new Uint8Array(n);
      var x, y;

      // ---- 第一遍：块累加 + 全局色相 ----
      for (y = 0; y < h; y++) {
        var by = Math.min(rows - 1, Math.floor(y / ch));
        for (x = 0; x < w; x++) {
          var bx = Math.min(cols - 1, Math.floor(x / cw));
          var B = blocks[by * cols + bx];
          var i = (y * w + x) * 4;
          var r = data[i], g = data[i + 1], b = data[i + 2];
          var L = 0.299 * r + 0.587 * g + 0.114 * b;
          var S = Math.max(r, g, b) - Math.min(r, g, b);
          brightSum += L;
          B.n++; B.Ls += L; B.Ss += S;
          // 低饱和像素（两种纸 + 墨）的亮度直方图，主峰即该块所在纸面
          if (S < 80) B.histL[Math.min(31, Math.floor(L / 8))]++;

          if (S > 35) {
            if (g >= r && g >= b && g - b > 14) { green++; hueMask[i >> 2] = 1; }
            // 黄色要求 r、g 接近（牛皮纸 r 明显大于 g，落到棕色）
            else if (r > 115 && g > 115 && r - b > 38 && g - b > 38 &&
                     Math.abs(r - g) < 28) { yellow++; hueMask[i >> 2] = 2; }
            else if (r >= g && r > b && r - g > 22) {
              red++;
              // 掩码只留“真红”（红浆果/红花/红印章）：
              // g 明显低、b 极低；牛皮纸暖影(约180,120,90)、橙色花心、
              // 深红枝条都不收
              if (L >= 95 && r >= 155 && g < 130 && r - g >= 65 && b < r - 95) {
                hueMask[i >> 2] = 3;
              }
            }
            else if (b > r && b >= g) { blue++; hueMask[i >> 2] = 4; }
            else if (r > g && g > b && L >= 80 && L <= 200) { brown++; hueMask[i >> 2] = 5; }
          } else if (S > 16 && r > g && g > b && L >= 80 && L <= 200) {
            brown++; hueMask[i >> 2] = 5;
          }
          // 红色像素（印章特征）：收紧判据，排除橙棕色牛皮纸
          if (r > 135 && g < 120 && r - g > 50 && r - b > 60) B.redPx++;
        }
      }

      // 块均值 + 自身纸面亮度（直方图主峰，不跨块平滑）
      blocks.forEach(function (B) {
        B.L = B.Ls / B.n; B.S = B.Ss / B.n;
        var peak = 0, h;
        for (h = 1; h < 32; h++) if (B.histL[h] > B.histL[peak]) peak = h;
        B.paperL = peak * 8 + 4;
      });

      // ---- 各块局部底色：5×5 邻域内“低饱和、偏亮”的块 ----
      // 棕纸+白纸拼贴也能分别估出各自底色，淡彩内容不会因全局阈值漏检。
      blocks.forEach(function (B, idx) {
        var cx0 = idx % cols, cy0 = (idx - cx0) / cols;
        var cand = [], dx, dy;
        for (dy = -2; dy <= 2; dy++) {
          var yy = cy0 + dy;
          if (yy < 0 || yy >= rows) continue;
          for (dx = -2; dx <= 2; dx++) {
            var xx = cx0 + dx;
            if (xx < 0 || xx >= cols) continue;
            cand.push(blocks[yy * cols + xx]);
          }
        }
        // 底色取邻域中位数：拼贴双纸色交界附近也不会被另一种纸带偏
        cand.sort(function (a, b) { return a.S - b.S; });
        B.pS = cand[Math.min(cand.length - 1, Math.floor(cand.length * 0.55))].S;
        cand.sort(function (a, b) { return a.L - b.L; });
        B.pL = cand[Math.min(cand.length - 1, Math.floor(cand.length * 0.5))].L;
      });

      // ---- 第二遍：相对局部底色分类 ----
      var cover = 0, strongCover = 0, dark = 0, colorPx = 0, heavy = 0, totalRed = 0;
      var inkMask = new Uint8Array(n);
      var edgeBand = Math.max(2, Math.round(Math.min(w, h) * 0.035));
      var edgeHit = [0, 0, 0, 0], edgeTot = [0, 0, 0, 0];
      // 环带内部分类：[ink, col, light]
      var edgeDetail = [[0, 0, 0], [0, 0, 0], [0, 0, 0], [0, 0, 0]];
      // 最外缘像素线：[hit, tot]——画框线时最外缘是空的，植物长到边时最外缘是满的
      var outerLine = [[0, 0], [0, 0], [0, 0], [0, 0]];

      for (y = 0; y < h; y++) {
        var by2 = Math.min(rows - 1, Math.floor(y / ch));
        for (x = 0; x < w; x++) {
          var bx2 = Math.min(cols - 1, Math.floor(x / cw));
          var B2 = blocks[by2 * cols + bx2];
          var j = (y * w + x) * 4;
          var rr = data[j], gg = data[j + 1], bb = data[j + 2];
          var LL = 0.299 * rr + 0.587 * gg + 0.114 * bb;
          var SS = Math.max(rr, gg, bb) - Math.min(rr, gg, bb);

          var isInk = LL < B2.pL - 30;                    // 淡墨/淡影也算
          var isInk2 = LL < B2.pL - 55 && SS < 70;         // 重墨：文字、大字
          var isCol = SS > B2.pS + 22 && SS > 30;          // 淡彩也算
          var isCol2 = SS > B2.pS + 36 && SS > 44;         // 浓彩
          var isLight = LL > B2.pL + 35 && SS < 60;        // 亮色：白纸上棕底的白线条/白撕纸
          var isContent = isInk || isCol || isLight;

          if (isContent) cover++;
          if (isInk2 || isCol2) strongCover++;
          if (LL < 85) dark++;
          if (isCol) {
            colorPx++;
            if (LL < 105) heavy++;
          }
          if (isInk) { B2.ink++; inkMask[j >> 2] = 1; }
          if (isInk2) B2.ink2++;
          if (isCol) B2.col++;
          if (isCol2) B2.col2++;
          if (isLight) B2.light++;

          function edgeCount(idx) {
            edgeTot[idx]++;
            if (isContent) edgeHit[idx]++;
            if (isInk) edgeDetail[idx][0]++;
            if (isCol) edgeDetail[idx][1]++;
            if (isLight) edgeDetail[idx][2]++;
          }
          function outerCount(idx) {
            outerLine[idx][1]++;
            if (isContent) outerLine[idx][0]++;
          }
          if (y === 0) outerCount(0);
          if (y === h - 1) outerCount(1);
          if (x === 0) outerCount(2);
          if (x === w - 1) outerCount(3);
          if (y < edgeBand) edgeCount(0);
          if (y >= h - edgeBand) edgeCount(1);
          if (x < edgeBand) edgeCount(2);
          if (x >= w - edgeBand) edgeCount(3);
        }
      }
      blocks.forEach(function (B) {
        B.inkR = B.ink / B.n; B.ink2R = B.ink2 / B.n;
        B.colR = B.col / B.n; B.col2R = B.col2 / B.n;
        B.lightR = B.light / B.n;
        B.contentR = (B.ink + B.col + B.light) / B.n;
        B.redR = B.redPx / B.n;
        totalRed += B.redPx;
      });

      // ---- 聚合为九宫格（构图识别沿用） ----
      var cells = [];
      var gy, gx;
      for (gy = 0; gy < 3; gy++) {
        var r0 = Math.floor(gy * rows / 3), r1 = Math.floor((gy + 1) * rows / 3);
        for (gx = 0; gx < 3; gx++) {
          var c0 = Math.floor(gx * cols / 3), c1 = Math.floor((gx + 1) * cols / 3);
          var cn = 0, cInk = 0, cInk2 = 0, cCol = 0, cContent = 0, yy2, xx2;
          for (yy2 = r0; yy2 < r1; yy2++) {
            for (xx2 = c0; xx2 < c1; xx2++) {
              var BB = blocks[yy2 * cols + xx2];
              cn += BB.n; cInk += BB.ink; cInk2 += BB.ink2;
              cCol += BB.col; cContent += BB.ink + BB.col + BB.light;
            }
          }
          cells.push({
            coverage: cContent / cn,
            inkRatio: cInk / cn,
            ink2Ratio: cInk2 / cn,
            colorRatio: cCol / cn
          });
        }
      }

      // 文字区标记：在主体连通分量分析之后进行（文字 = 主体之外、贴边的墨区）

      var densities = cells.map(function (c) { return c.coverage; });
      var dMean = densities.reduce(function (a, b) { return a + b; }, 0) / 9;
      var dVar = densities.reduce(function (a, d) { return a + (d - dMean) * (d - dMean); }, 0) / 9;

      var grid = {
        top: (densities[0] + densities[1] + densities[2]) / 3,
        mid: (densities[3] + densities[4] + densities[5]) / 3,
        bottom: (densities[6] + densities[7] + densities[8]) / 3,
        left: (densities[0] + densities[3] + densities[6]) / 3,
        centerCol: (densities[1] + densities[4] + densities[7]) / 3,
        right: (densities[2] + densities[5] + densities[8]) / 3,
        d1: (densities[0] + densities[4] + densities[8]) / 3,
        d2: (densities[2] + densities[4] + densities[6]) / 3,
        corner: (densities[0] + densities[2] + densities[6] + densities[8]) / 4,
        border: (densities[1] + densities[3] + densities[5] + densities[7]) / 4,
        center: densities[4]
      };

      // ---- 主体：内容块最大连通分量 ----
      var filled = blocks.map(function (B) { return B.contentR >= 0.14; });
      var seen = new Array(nb).fill(false);
      var best = [], si;
      for (si = 0; si < nb; si++) {
        if (!filled[si] || seen[si]) continue;
        var stack = [si], comp = [], cur;
        seen[si] = true;
        while (stack.length) {
          cur = stack.pop();
          comp.push(cur);
          var ccx = cur % cols, ccy = (cur - ccx) / cols;
          var nbrs = [[1, 0], [-1, 0], [0, 1], [0, -1]], q;
          for (q = 0; q < 4; q++) {
            var nx = ccx + nbrs[q][0], ny = ccy + nbrs[q][1];
            if (nx < 0 || nx >= cols || ny < 0 || ny >= rows) continue;
            var ni2 = ny * cols + nx;
            if (!seen[ni2] && filled[ni2]) { seen[ni2] = true; stack.push(ni2); }
          }
        }
        if (comp.length > best.length) best = comp;
      }
      var subject;
      if (best.length) {
        var minX = cols, maxX = -1, minY = rows, maxY = -1, crSum = 0, z;
        for (z = 0; z < best.length; z++) {
          var cx2 = best[z] % cols, cy2 = (best[z] - cx2) / cols;
          if (cx2 < minX) minX = cx2;
          if (cx2 > maxX) maxX = cx2;
          if (cy2 < minY) minY = cy2;
          if (cy2 > maxY) maxY = cy2;
          crSum += blocks[best[z]].contentR;
        }
        subject = {
          blocks: best.length,
          bbox: ((maxX - minX + 1) * (maxY - minY + 1)) / nb,
          fillRate: crSum / best.length,
          spanX: (maxX - minX + 1) / cols,
          spanY: (maxY - minY + 1) / rows,
          minX: minX, maxX: maxX, minY: minY, maxY: maxY
        };
      } else {
        subject = { blocks: 0, bbox: 0, fillRate: 0, spanX: 0, spanY: 0 };
      }
      subject.prominent =
        (subject.bbox >= 0.2 && subject.fillRate >= 0.3 && subject.blocks >= 6) ||
        (subject.spanX >= 0.75 && subject.spanY >= 0.6 && subject.blocks >= 10);

      // ---- 文字区：主体连通分量之外、贴边的墨色区域 ----
      // 教学版面中文字与植物主体总是分离的；主体外的成片墨色即标题/功效文字。
      var inSubject = new Array(nb).fill(false);
      best.forEach(function (bi) { inSubject[bi] = true; });
      cells.forEach(function (c, k3) {
        var gx3 = k3 % 3, gy3 = (k3 - gx3) / 3;
        var c0b = Math.floor(gx3 * cols / 3), c1b = Math.floor((gx3 + 1) * cols / 3);
        var r0b = Math.floor(gy3 * rows / 3), r1b = Math.floor((gy3 + 1) * rows / 3);
        var outInk = 0, outN = 0, totalN = 0, bigStroke = 0, smallInk = 0, ayb, axb;
        for (ayb = r0b; ayb < r1b; ayb++) {
          for (axb = c0b; axb < c1b; axb++) {
            var idxB = ayb * cols + axb;
            var Bb = blocks[idxB];
            totalN += Bb.n;
            if (inSubject[idxB]) continue;
            outN += Bb.n;
            outInk += Bb.ink;
            if (Bb.inkR >= 0.28) bigStroke++;
            else if (Bb.inkR >= 0.045) smallInk++;
          }
        }
        c.outsideRatio = outN / totalN;
        c.outsideInkRatio = outN ? outInk / outN : 0;
        c.bigStrokeBlocks = bigStroke;
        c.smallInkBlocks = smallInk;
        // 文字区：格内一半以上面积在主体之外，且外部有足够墨色
        c.isTextArea = c.outsideRatio >= 0.5 && c.outsideInkRatio >= 0.035 &&
                       (smallInk >= 3 || bigStroke >= 1);
        // 大字标题区：粗笔大字块集中
        c.isTitleArea = c.outsideRatio >= 0.5 && bigStroke >= 2 && c.outsideInkRatio >= 0.1;
      });

      // ---- 纸张种类（拼贴检测），只用内部块，排除拍照背景/木桌 ----
      var darkPaper = 0, midPaper = 0, lightPaper = 0, innerN = 0;
      blocks.forEach(function (B) {
        var pcx = B.x, pcy = B.y;
        if (pcx < 1 || pcx >= cols - 1 || pcy < 1 || pcy >= rows - 1) return;
        innerN++;
        if (B.paperL < 140) darkPaper++;
        else if (B.paperL < 205) midPaper++;
        else lightPaper++;
      });
      var darkInner = darkPaper / innerN;
      var midInner = midPaper / innerN;
      var lightInner = lightPaper / innerN;
      // 撕贴边界：内部相邻块“自身纸面亮度”突变（撕纸边缘长而不规则）；
      // 单张纸的亮度变化是平滑渐变，相邻块不会突变。
      var seam = 0, seamTot = 0;
      var seamMask = new Array(nb).fill(false);
      blocks.forEach(function (B) {
        if (B.x < 1 || B.x >= cols - 1 || B.y < 1 || B.y >= rows - 1) return;
        var BRight = blocks[B.y * cols + B.x + 1];
        var BDown = blocks[(B.y + 1) * cols + B.x];
        seamTot += 2;
        var jumpR = Math.abs(B.paperL - BRight.paperL) > 40;
        var jumpD = Math.abs(B.paperL - BDown.paperL) > 40;
        if (jumpR) seam++;
        if (jumpD) seam++;
        if (jumpR || jumpD) seamMask[B.y * cols + B.x] = true;
      });
      var seamRatio = seamTot ? seam / seamTot : 0;
      // 拼贴：任意两类纸面各占内部 ≥15%，且存在连续突变边界
      var bigClassN = 0;
      [darkInner, midInner, lightInner].forEach(function (v) {
        if (v >= 0.15) bigClassN++;
      });
      var hasCollage = seamRatio >= 0.06 && bigClassN >= 2;
      var paperKinds = hasCollage ? 2 : 1;
      var darkPaperRatio = darkInner;

      // ---- 边框：四边环带都有细而连续的内容 ----
      var edgeRatios = edgeHit.map(function (v, i) { return v / edgeTot[i]; });
      var outerFill = outerLine.map(function (o) { return o[1] ? o[0] / o[1] : 0; });
      var edgeSplit = edgeDetail.map(function (d, i) {
        return { ink: d[0] / edgeTot[i], col: d[1] / edgeTot[i], light: d[2] / edgeTot[i] };
      });
      var frame = edgeRatios[0] >= 0.22 && edgeRatios[0] <= 0.85 &&
                  edgeRatios[1] >= 0.22 && edgeRatios[1] <= 0.85 &&
                  edgeRatios[2] >= 0.22 && edgeRatios[2] <= 0.85 &&
                  edgeRatios[3] >= 0.22 && edgeRatios[3] <= 0.85;

      // ---- 印章：红色像素集中在很小的区域 ----
      var redRatio = totalRed / n;
      var redBlockCnt = 0, redBlockStrong = 0;
      blocks.forEach(function (B) {
        if (B.redR >= 0.02) redBlockCnt++;
        if (B.redR >= 0.05) redBlockStrong++;
      });
      var seal = redRatio >= 0.005 && redRatio <= 0.06 &&
                 redBlockStrong >= 1 && redBlockCnt <= Math.round(nb * 0.12);

      var hueKinds = 0;
      [green, yellow, red, blue, brown].forEach(function (v) {
        if (v / n >= 0.02) hueKinds++;
      });

      // ============================================================
      // 造型细节：在色相掩码上做连通分量，分辨叶、花、果、根
      // ============================================================
      function colorComponents(code, bounds) {
        var codes = code instanceof Array ? code : [code];
        var marked = new Uint8Array(n);
        var list = [];
        var px, py;
        for (var p0 = 0; p0 < n; p0++) {
          if (codes.indexOf(hueMask[p0]) < 0 || marked[p0]) continue;
          if (bounds) {
            var ppX = p0 % w, ppY = (p0 - ppX) / w;
            if (ppX < bounds.x0 || ppX > bounds.x1 || ppY < bounds.y0 || ppY > bounds.y1) continue;
          }
          marked[p0] = 1;
          var stk = [p0], c = {
            size: 0, minX: w, maxX: -1, minY: h, maxY: -1,
            sx: 0, sy: 0, sxx: 0, syy: 0, sxy: 0, ink: 0, inkIn: 0,
            redN: 0, yellowN: 0
          };
          while (stk.length) {
            var p = stk.pop();
            px = p % w; py = (p - px) / w;
            c.size++;
            if (hueMask[p] === 3) c.redN++; else if (hueMask[p] === 2) c.yellowN++;
            if (px < c.minX) c.minX = px;
            if (px > c.maxX) c.maxX = px;
            if (py < c.minY) c.minY = py;
            if (py > c.maxY) c.maxY = py;
            c.sx += px; c.sy += py;
            c.sxx += px * px; c.syy += py * py; c.sxy += px * py;
            // 4 邻域
            var nbrs2 = px > 0 ? p - 1 : -1, nbrs3 = px < w - 1 ? p + 1 : -1,
                nbrs4 = p - w, nbrs5 = p + w;
            [nbrs2, nbrs3].forEach(function (npv) {
              if (npv >= 0 && !marked[npv] && (!bounds ||
                  (npv % w >= bounds.x0 && npv % w <= bounds.x1))) {
                if (codes.indexOf(hueMask[npv]) >= 0) { marked[npv] = 1; stk.push(npv); }
              }
            });
            [nbrs4, nbrs5].forEach(function (npv) {
              if (npv >= 0 && npv < n && !marked[npv] && (!bounds ||
                  ((npv - npv % w) / w >= bounds.y0 && (npv - npv % w) / w <= bounds.y1))) {
                if (codes.indexOf(hueMask[npv]) >= 0) { marked[npv] = 1; stk.push(npv); }
              }
            });
          }
          // bbox 内墨点（果脐/花蕊）；内缩 4px 的墨点（叶脉，排除叶片外轮廓）
          var qx, qy;
          for (qy = c.minY; qy <= c.maxY; qy++) {
            for (qx = c.minX; qx <= c.maxX; qx++) {
              if (inkMask[qy * w + qx]) {
                c.ink++;
                if (qx >= c.minX + 4 && qx <= c.maxX - 4 &&
                    qy >= c.minY + 4 && qy <= c.maxY - 4) c.inkIn++;
              }
            }
          }
          c.bw = c.maxX - c.minX + 1; c.bh = c.maxY - c.minY + 1;
          c.edge = Math.max(c.bw, c.bh);
          c.compact = c.size / (c.bw * c.bh);
          list.push(c);
        }
        return list;
      }

      var shapeEv = null;
      if (subject && subject.blocks) {
        var pad = 8;
        var bnd = {
          x0: Math.max(0, Math.floor(subject.minX * cw) - pad),
          x1: Math.min(w - 1, Math.ceil((subject.maxX + 1) * cw) + pad),
          y0: Math.max(0, Math.floor(subject.minY * ch) - pad),
          y1: Math.min(h - 1, Math.ceil((subject.maxY + 1) * ch) + pad)
        };
        var greensC = colorComponents(1, null);
        var warmsC = colorComponents([2, 3], bnd);
        var bluesC = colorComponents(4, bnd);

        // 叶片：绿色分量 ≥60px
        var leaves = greensC.filter(function (c) { return c.size >= 60; });
        var leafOrient = [];
        var veinArea = 0, veinInk = 0;
        leaves.forEach(function (c) {
          var nn = c.size, mcx = c.sx / nn, mcy = c.sy / nn;
          var vxx = c.sxx / nn - mcx * mcx, vyy = c.syy / nn - mcy * mcy,
              vxy = c.sxy / nn - mcx * mcy;
          var diff = vxx - vyy;
          var theta = 0.5 * Math.atan2(2 * vxy, diff);
          var tr = vxx + vyy, disc = Math.sqrt(diff * diff + 4 * vxy * vxy);
          var lam1 = (tr + disc) / 2, lam2 = (tr - disc) / 2;
          var elong = Math.sqrt((lam1 + 0.5) / (lam2 + 0.5));
          if (elong >= 1.25) leafOrient.push(theta);
          // 内部区域（外轮廓内缩）的墨点密度
          var iw = Math.max(1, c.bw - 8), ih = Math.max(1, c.bh - 8);
          veinArea += iw * ih; veinInk += c.inkIn;
        });
        // 朝向分散度：用倍角向量（叶轴 180° 等价）
        var vx2 = 0, vy2 = 0;
        leafOrient.forEach(function (t) { vx2 += Math.cos(2 * t); vy2 += Math.sin(2 * t); });
        var orientSpread = leafOrient.length
          ? 1 - Math.sqrt(vx2 * vx2 + vy2 * vy2) / leafOrient.length : 0;
        var veinMetric = veinArea ? veinInk / veinArea : 0;

        // 黄色花朵：暖色分量里较饱满的团/碎块（水彩花瓣常断裂）
        var yellowFlowers = 0;
        warmsC.forEach(function (c) {
          var redDom = c.redN > c.yellowN * 1.5;
          if (redDom) return;
          if (c.size >= 200 && c.edge >= 30 && c.compact >= 0.4) yellowFlowers++;
          else if (c.size >= 120 && c.edge >= 20 && c.compact >= 0.4) yellowFlowers++;
        });

        // 果脐：墨点被暖色（黄/红）5×5 环大面积包围
        // —— 水彩果面色相碎裂，8 邻域不成立，用 24 邻环 ≥14
        var bx0p = Math.floor(subject.minX * cw), bx1p = Math.ceil((subject.maxX + 1) * cw),
            by0p = Math.floor(subject.minY * ch), by1p = Math.ceil((subject.maxY + 1) * ch);
        var starPts = [];
        var ryy, rxx;
        for (ryy = Math.max(3, by0p); ryy < Math.min(h - 3, by1p); ryy++) {
          for (rxx = Math.max(3, bx0p); rxx < Math.min(w - 3, bx1p); rxx++) {
            var pp = ryy * w + rxx;
            if (!inkMask[pp]) continue;
            var w5 = 0, y5 = 0;
            for (var dyy = -2; dyy <= 2; dyy++) {
              for (var dxx = -2; dxx <= 2; dxx++) {
                if (!dxx && !dyy) continue;
                var hv5 = hueMask[pp + dyy * w + dxx];
                if (hv5 === 2) { w5++; y5++; }
                else if (hv5 === 3) w5++;
              }
            }
            // 果脐：暖环≥14 且其中真黄≥10（红浆果上的黑点不算）
            if (w5 >= 14 && y5 >= 10) starPts.push([rxx, ryy]);
          }
        }
        // 星点聚类：12px 内同一颗，贪心归并
        var fruitStars = 0;
        starPts.forEach(function (pt) {
          var near = false;
          for (var i = 0; i < starPts.length; i++) { var q = starPts[i];
            if (q === pt) break;
            if (Math.abs(q[0] - pt[0]) <= 12 && Math.abs(q[1] - pt[1]) <= 12) { near = true; break; }
          }
          if (!near) fruitStars++;
        });
        // 有黄色花朵证据时，这些点是花心不是果脐
        if (yellowFlowers >= 1) fruitStars = 0;

        // 红色果实：看“团状红像素”（3×3 邻域红≥1），
        // 真红掩码已排除枝条/牛皮纸/橙晕；小颗水彩浆果也能计入
        var blobRed = 0;
        for (ryy = Math.max(1, by0p); ryy < Math.min(h - 1, by1p); ryy++) {
          for (rxx = Math.max(1, bx0p); rxx < Math.min(w - 1, bx1p); rxx++) {
            var rp = ryy * w + rxx;
            if (hueMask[rp] !== 3) continue;
            var cnt = 0;
            for (var dyy2 = -1; dyy2 <= 1; dyy2++) {
              for (var dxx2 = -1; dxx2 <= 1; dxx2++) {
                if (!dyy2 && !dxx2) continue;
                if (hueMask[rp + dyy2 * w + dxx2] === 3) cnt++;
              }
            }
            if (cnt >= 1) blobRed++;
          }
        }
        var redFruitRatio = blobRed / n;
        // 红果已单独描述时，不再叠加果脐句
        if (redFruitRatio >= 0.01) fruitStars = 0;
        // 蓝色花朵（蓝紫色花冠会分成若干碎块，看总体有无）
        var blueFlower = bluesC.filter(function (c) { return c.size >= 60; }).length;

        // 根须：单纸画面中、主体下部的棕色分量（拼贴牛皮纸本身是棕色，豁免）
        var roots = 0;
        if (paperKinds === 1) {
          var brownsC = colorComponents(5, bnd);
          brownsC.forEach(function (c) {
            var cyc = (c.minY + c.maxY) / 2;
            if (cyc >= bnd.y0 + (bnd.y1 - bnd.y0) * 0.6 && c.size >= 40) roots++;
          });
        }

        shapeEv = {
          leafCount: leaves.length,
          orientSpread: orientSpread,
          veinMetric: veinMetric,
          fruitStars: fruitStars,
          yellowFlowers: yellowFlowers,
          redFruitRatio: redFruitRatio,
          blueFlower: blueFlower,
          roots: roots
        };
      }

      return {
        aspect: w / h,
        brightness: brightSum / n,
        coverage: cover / n,
        strongCoverage: strongCover / n,
        darkRatio: dark / n,
        colorRatio: colorPx / n,
        heavyColorRatio: heavy / n,
        greenRatio: green / n,
        yellowRatio: yellow / n,
        redRatio: red / n,
        blueRatio: blue / n,
        brownRatio: brown / n,
        hueKinds: hueKinds,
        paperKinds: paperKinds,
        darkPaperRatio: darkPaperRatio,
        seamRatio: seamRatio,
        frame: frame,
        edgeRatios: edgeRatios,
        outerFill: outerFill,
        seal: seal,
        subject: subject,
        densityStd: Math.sqrt(dVar),
        grid: grid,
        cells: cells,
        blocks: blocks,
        inSubject: inSubject,
        shapeEv: shapeEv
      };
    });
  }

  /* 构图识别：依据九宫格真实密度证据匹配课件术语 */
  function detectComposition(f) {
    var g = f.grid;

    if (f.coverage < 0.16) {
      return { name: COMPOSITION_NONE, confidence: 0.85 };
    }

    // ---- 文字证据（区分“文字区”与长进来的枝叶） ----
    var textCorners = [0, 2, 6, 8].filter(function (i) {
      return f.cells[i].isTextArea;
    }).length;
    var borderTextAreas = [1, 3, 5, 7].filter(function (i) {
      return f.cells[i].isTextArea;
    }).length;

    // 文字/装饰沿四周边格环绕（至少 3 条边）、中心留给主体 → 包围式
    if (textCorners >= 3 && borderTextAreas >= 3 && g.center >= 0.28) {
      return { name: '包围式构图', confidence: 0.82 };
    }

    // 对角：某条对角线密度明显高
    var diagStrength = Math.max(g.d1, g.d2);
    var diagGap = Math.abs(g.d1 - g.d2);
    if (diagStrength >= 0.42 && (diagGap > 0.04 || textCorners < 3)) {
      return { name: '对角式', confidence: Math.min(0.9, 0.55 + diagStrength / 3) };
    }

    // 中心突出
    if (g.center >= 0.52 && g.center - ((g.border + g.corner) / 2) > 0.10) {
      if ((g.border + g.corner) / 2 < 0.26) return { name: '居中构图', confidence: 0.8 };
      return { name: '中心发散式', confidence: 0.78 };
    }

    // 左右式
    if (Math.abs(g.left - g.right) > 0.12 && Math.max(g.left, g.right) >= 0.45) {
      return { name: '左右式', confidence: 0.72 };
    }

    // 上下式
    if (Math.abs(g.top - g.bottom) > 0.12 && Math.max(g.top, g.bottom) >= 0.45) {
      return { name: '上下式', confidence: 0.72 };
    }

    // 四角构图
    if (g.corner >= 0.42 && g.center < g.corner - 0.08) {
      return { name: '四角构图', confidence: 0.7 };
    }

    // 对称
    if (Math.abs(g.left - g.right) < 0.06 && g.left >= 0.34 && g.right >= 0.34) {
      return { name: '对称构图', confidence: 0.66 };
    }

    // 散点：各格均匀且都较满
    if (f.densityStd < 0.07 && f.coverage >= 0.45) {
      return { name: '散点构图', confidence: 0.62 };
    }

    // S 形曲线：中心列与左右交替饱满（启发式，置信度给低）
    if (g.centerCol >= 0.4 && Math.abs(g.top - g.bottom) < 0.12 && f.coverage >= 0.4) {
      return { name: 'S形曲线构图', confidence: 0.5 };
    }

    if (f.coverage >= 0.22) {
      // 证据不足以确定版式：选最接近的一种，低置信度
      var candidates = [
        { name: '对角式', v: diagStrength },
        { name: '中心发散式', v: g.center },
        { name: '左右式', v: Math.max(g.left, g.right) },
        { name: '上下式', v: Math.max(g.top, g.bottom) }
      ].sort(function (a, b) { return b.v - a.v; });
      return { name: candidates[0].name, confidence: 0.42 };
    }

    return { name: COMPOSITION_NONE, confidence: 0.7 };
  }

  /* 每个维度 × 每个等级的评价结论（画面口吻） */
  var MOCK_COMMENTS = {
    shape: {
      '优秀': ['准确抓住了这株本草的典型外形特征，叶片前后遮挡、翻转姿态表现到位，茎叶自然生动，能看出认真观察的成果。', '植物造型完整生动，叶片的朝向和遮挡关系处理得很好，茎干形态自然，没有僵硬对称的感觉。'],
      '良好': ['能表现本草的主要外形特征，大部分叶片形态准确，少量遮挡关系还可以再交代清楚一些。', '植物整体造型比较自然，茎叶特征基本到位，个别叶片的翻转姿态可以再细致观察。'],
      '合格': ['本草的外形已经画出来、能够辨认，建议对照资料再看一看叶片的排列方式，可以挑两三片叶子画出前后遮挡，造型会更生动。', '植物外形基本可辨，下一步可以从根部往上观察茎干的弯曲走向，再给一两片叶子画出翻折，画面会更有变化。'],
      '待改进': ['植物形态较难辨认，还没有表现出这株本草的基本外形特征，建议对照实物重新观察茎叶形状。', '叶片和茎干的形态过于简单，看不出具体是哪一种本草，造型需要重画。']
    },
    technique: {
      '优秀': ['线条流畅且有轻重变化，淡彩通透清淡、没有遮盖轮廓线，色彩也贴合植物的真实色调，技法落实得很好。', '勾线肯定流畅，上色先浅后深、干净通透，轮廓线清晰保留，色调真实自然。'],
      '良好': ['线条整体流畅，只有少量涂改痕迹；淡彩基本清淡，局部颜色略重，轮廓线大部分保留。', '勾线比较连贯，淡彩效果清新，个别区域颜色可以再调浅一些。'],
      '合格': ['轮廓线基本完整，上色已经完成，但部分区域颜色偏重，有少量地方盖住了勾线。', '能够完成勾线和上色，色彩基本均匀，局部上色不够清淡，影响了线条表现。'],
      '待改进': ['线条有些杂乱、难以辨认，上色大面积糊掉并盖住了轮廓，建议重新勾线后再用浅淡的颜色上色。', '勾线不连贯且涂改较多，涂色过重破坏了线描轮廓，技法上需要从头修整。']
    },
    knowledge: {
      '优秀': ['中草药名称标注准确，功效介绍简洁正确，文字书写工整，很符合本草记录的特点。', '名称、功效信息准确完整，字迹工整清晰，能看出对本草文化的认真理解。'],
      '良好': ['本草名称书写正确，功效信息基本无误，书写也比较工整。', '名称准确，功效介绍大体正确，个别字迹可以再写整齐一些。'],
      '合格': ['写出了本草名称，但功效内容比较简单，文字稍显潦草。', '有名称和简单的文字介绍，功效信息不足，书写不够工整。'],
      '待改进': ['缺少植物名称，也没有本草相关的文字介绍，需要补齐名称和功效说明。', '版面看不到本草知识文本，文本内容是必须补做的部分。']
    },
    creativity: {
      // 仅作备用；正常评语由检测到的闪光点现场组合
      'base': [
        '按要求搜集了本草资料，完整画出植物样貌并配上介绍，作业完成得很认真。',
        '本草样貌和基本介绍都齐全，看得出认真查过资料，基础任务完成得很扎实。',
        '把植物的样子和文字介绍都完整呈现出来了，是一页合格的本草记录。'
      ],
      '待改进': ['画面还没有完成，先把植物外形、颜色和名称介绍补齐，老师期待看到你补全后的作品。']
    }
  };

  var OVERALL_COMMENTS = {
    '优秀': '这是一页完成度很高的本草画册内页：植物特征抓得准确，线描淡彩干净，图文排版美观，本草信息正确，还能看出你自己的观察与思考，很好地体现了本草图谱科学与艺术结合的特点，继续保持！',
    '良好': '整页作业完成质量较好，本草造型与技法表现扎实，图文排版基本合理。若能在细节刻画和版面精致度上再进一步，就可以达到优秀水平，继续加油！',
    '合格': '作业已经基本完成，能够辨认出所画本草，也具备画册内页的雏形。建议对照评价标准，在造型细节、淡彩轻重、文字信息和版面主次上继续修改完善。',
    '待改进': '目前作品还没有达到本草画册内页的基础要求。建议先补齐植物名称与功效文字，完成勾线和上色，并重新观察植物、把茎叶外形画清楚，老师期待看到你的修改。'
  };

  function pickRandom(arr) {
    return arr[Math.floor(Math.random() * arr.length)];
  }

  function pickLevel(probs) {
    var r = Math.random(), acc = 0;
    for (var i = 0; i < probs.length; i++) {
      acc += probs[i];
      if (r < acc) return LEVELS[i];
    }
    return '合格';
  }

  /* =========================================================
   * 各维度等级：全部由画面真实证据决定
   * 原则：先认定学生完成了作业，只有真实的空白/糊色/无文字
   * 证据才给低等级——认真画了的孩子不应被随机判低分。
   * ========================================================= */
  /* 文字证据：主体之外的墨色区域 = 名称 / 功效文字
   * - 角格是小字区或大字区 → 该角有文字
   * - outsideInkBlocks：全画面主体外的墨块数（兜底，防止文字通过窄桥被主体吞掉） */
  function knowledgeEvidence(f) {
    var cornerText = [0, 2, 6, 8].filter(function (i) {
      var c = f.cells[i];
      return c.isTextArea || c.isTitleArea;
    }).length;
    var titleCorners = [0, 2, 6, 8].filter(function (i) {
      return f.cells[i].isTitleArea;
    }).length;
    var outsideInkBlocks = 0, bigOutside = 0, darkInkBlocks = 0, darkBigBlocks = 0, k4;
    for (k4 = 0; k4 < f.blocks.length; k4++) {
      var B4 = f.blocks[k4];
      var ir = B4.inkR;
      if (!f.inSubject[k4]) {
        if (ir >= 0.045) outsideInkBlocks++;
        if (ir >= 0.28) bigOutside++;
      }
      // 拼贴画面：深色衬纸上的墨块 = 写在衬纸上的标题/功效
      // （即使这些块被主体连通吞掉也能被数到）
      if (f.paperKinds >= 2 && B4.paperL < 200) {
        if (ir >= 0.045) darkInkBlocks++;
        if (ir >= 0.28) darkBigBlocks++;
      }
    }
    var strongN = Math.max(outsideInkBlocks, darkInkBlocks);
    // 文字证据的综合量：角证据与全局块证据取较强者
    var textScore = Math.max(cornerText, strongN >= 10 ? 3
                            : strongN >= 5 ? 2
                            : strongN >= 2 ? 1 : 0);
    return {
      textCorners: textScore,
      cornerText: cornerText,
      outsideInkBlocks: strongN,
      hasTitle: titleCorners >= 1 || bigOutside >= 2 || darkBigBlocks >= 2
    };
  }

  function assessShape(f) {
    if (!f) return pickLevel([0.15, 0.7, 0.15, 0]);
    if (f.brightness < 90 || f.darkRatio > 0.45) return pickLevel([0.1, 0.55, 0.35, 0]);
    // 色彩丰富、有叶有花：造型细节通常也更充分
    var rich = f.colorRatio >= 0.2 && f.greenRatio >= 0.08 &&
               (f.yellowRatio + f.redRatio) >= 0.05;
    if (rich && f.coverage >= 0.35) return pickLevel([0.7, 0.3, 0, 0]);
    if (f.coverage >= 0.55) return pickLevel([0.6, 0.4, 0, 0]);
    if (f.coverage >= 0.32) return pickLevel([0.15, 0.55, 0.3, 0]);
    // 画面已铺满约 1/5 = 基本造型已完成，待改进只留给真正空白/稀疏的画面
    if (f.coverage >= 0.18) {
      if (f.colorRatio >= 0.08) return pickLevel([0.1, 0.45, 0.45, 0]);
      return pickLevel([0, 0.2, 0.8, 0]);
    }
    // 白底淡彩/数字插画覆盖率低但有明确上色：造型已完成，不给待改进
    if (f.coverage >= 0.1 && f.colorRatio >= 0.06) {
      return pickLevel([0.05, 0.4, 0.55, 0]);
    }
    if (f.coverage >= 0.08) return pickLevel([0, 0.12, 0.6, 0.28]);
    // 近乎空白：区分“真空白”与“零星画了一点”
    if (f.colorRatio < 0.012 && f.darkRatio < 0.02) return pickLevel([0, 0, 0.25, 0.75]);
    return pickLevel([0, 0.08, 0.55, 0.37]);
  }

  function assessTechnique(f) {
    if (!f) return pickLevel([0.15, 0.7, 0.15, 0]);
    // 只有真的出现大面积深色重彩糊线才给低等级；
    // 整体亮度低（深色纸张、室内拍照偏暗）不算技法问题
    if (f.heavyColorRatio >= 0.17) {
      return pickLevel([0, 0.2, 0.55, 0.25]);
    }
    // 真空白
    if (f.coverage < 0.08 && f.colorRatio < 0.012 && f.darkRatio < 0.02) {
      return pickLevel([0, 0, 0.3, 0.7]);
    }
    if (f.colorRatio >= 0.15) return pickLevel([0.58, 0.42, 0, 0]);
    if (f.colorRatio >= 0.05) return pickLevel([0.15, 0.55, 0.3, 0]);
    // 基本无色彩：线描完成给合格，又乱又暗才给待改进
    if (f.darkRatio > 0.3 && f.brightness < 120) return pickLevel([0, 0.1, 0.5, 0.4]);
    return pickLevel([0.05, 0.25, 0.6, 0.1]);
  }

  function assessLayout(comp, f, ev) {
    if (!f) return pickLevel([0.2, 0.6, 0.2, 0]);
    if (comp.name === COMPOSITION_NONE) {
      if (f.coverage < 0.08) return pickLevel([0, 0, 0.3, 0.7]);
      // 白底淡彩/数字插画覆盖率低，若文字证据充分，按已完成对待，不给待改进
      var textEvidence = ev && ev.outsideInkBlocks >= 30;
      if (f.coverage < 0.2) {
        return textEvidence ? pickLevel([0.1, 0.5, 0.4, 0])
                            : pickLevel([0, 0.08, 0.62, 0.3]);
      }
      if (f.coverage < 0.3) return pickLevel([0, 0.3, 0.7, 0]);
      return pickLevel([0, 0.45, 0.55, 0]);
    }
    // 对角/版式两端都有文字压阵：版式真正用起来了
    if (comp.confidence >= 0.65 && ev && ev.textCorners >= 2) {
      return pickLevel([0.65, 0.35, 0, 0]);
    }
    if (comp.confidence >= 0.7) return pickLevel([0.55, 0.45, 0, 0]);
    if (comp.confidence >= 0.5) return pickLevel([0.2, 0.55, 0.25, 0]);
    // 低置信只是证据不充分，不能给“不符合构图逻辑”的待改进
    return pickLevel([0.05, 0.4, 0.55, 0]);
  }

  function assessKnowledge(f, ev) {
    if (!f) return pickLevel([0.15, 0.7, 0.15, 0]);
    if (ev.textCorners >= 3 && ev.hasTitle) return pickLevel([0.75, 0.25, 0, 0]);
    if (ev.textCorners >= 3) return pickLevel([0.4, 0.6, 0, 0]);
    if (ev.textCorners === 2) return pickLevel([0.1, 0.6, 0.3, 0]);
    if (ev.textCorners === 1) {
      return f.coverage >= 0.3 ? pickLevel([0, 0.3, 0.55, 0.15]) : pickLevel([0, 0.1, 0.5, 0.4]);
    }
    return f.coverage >= 0.3 ? pickLevel([0, 0.1, 0.55, 0.35]) : pickLevel([0, 0, 0.3, 0.7]);
  }

  /* 闪光点：只报告画面里真实检测到的东西，没有就不夸 */
  function extractHighlights(f, comp, ev) {
    var h = {
      collage: f.paperKinds >= 2,
      seal: !!f.seal,
      frame: !!f.frame,
      title: !!ev.hasTitle,
      textRich: ev.textCorners >= 3,
      darkPaper: f.darkPaperRatio >= 0.18,
      multiHue: f.hueKinds >= 4
    };
    h.keys = Object.keys(h).filter(function (k) { return h[k] === true; });
    h.count = h.keys.length;
    return h;
  }

  function assessCreativity(f, comp, ev) {
    if (!f) return pickLevel([0.15, 0.7, 0.15, 0]);
    var hl = extractHighlights(f, comp, ev);
    // 大面积未完成：才给待改进
    if (f.coverage < 0.12) return pickLevel([0, 0.05, 0.35, 0.6]);
    // 先看闪光点：白底画面覆盖率本来就低，不能因覆盖率否定完成度
    if (hl.count >= 3) return pickLevel([0.62, 0.38, 0, 0]);
    if (hl.count >= 2) return pickLevel([0.4, 0.6, 0, 0]);
    if (hl.count >= 1) return pickLevel([0.15, 0.85, 0, 0]);
    // 无闪光点且画面偏空：合格为主，少量待改进
    if (f.coverage < 0.25) return pickLevel([0, 0.12, 0.68, 0.2]);
    return pickLevel([0, 0.9, 0.1, 0]);
  }

  /* =========================================================
   * 维度评语：必须提到画面里真实可见的具体内容
   * ========================================================= */
  /* 造型评语：每条夸赞都来自像素证据，写学生真正画出来的细节；
   * 没有具体证据时只用一句短话，绝不硬写“叶片朝向/翻转遮挡”等套话 */
  function shapeComment(f, level) {
    if (!f) return pickRandom(MOCK_COMMENTS.shape[level] || MOCK_COMMENTS.shape['合格']);
    var se = f.shapeEv;

    /* 候选具体细节：priority 越大越优先 */
    var cand = [];
    if (se) {
      if (se.redFruitRatio >= 0.04) {
        cand.push({ p: 10, k: 'rb', t: '一串串红色小果实，颗颗圆润饱满，前后堆叠、疏密自然' });
      } else if (se.redFruitRatio >= 0.01) {
        cand.push({ p: 10, k: 'rb', t: '红色小果实成串垂挂在枝叶间，颗颗圆润饱满' });
      }
      if (se.fruitStars >= 3) {
        cand.push({ p: 9.5, k: 'fs', t: '一颗颗圆形果实连顶端的星形果脐都点画出来了，果实成簇生长的样子观察得很仔细' });
      }
      if (se.blueFlower >= 2) {
        cand.push({ p: 8.5, k: 'bf', t: '蓝紫色花朵像小喇叭一样张开，盛开的花和未放的花苞都画了' });
      }
      if (se.yellowFlowers >= 3) {
        cand.push({ p: 8, k: 'yf', t: '黄色花朵有全开、半开的不同姿态，花瓣层层张开' });
      } else if (se.yellowFlowers >= 1) {
        cand.push({ p: 8, k: 'yf', t: '黄色花朵的花瓣层次和花蕊位置都有交代' });
      }
      if (se.orientSpread >= 0.55 && se.leafCount >= 4) {
        cand.push({ p: 6, k: 'lo', t: '叶片朝向各不相同，正面、侧面和翻转的叶片都有' });
      }
      if (se.veinMetric >= 0.1 && se.leafCount >= 3) {
        cand.push({ p: 5.5, k: 'vn', t: '叶片上的叶脉用细线勾得清楚，主脉和分脉都有交代' });
      }
      if (se.roots >= 1) {
        cand.push({ p: 3, k: 'rt', t: '根部交错的根须也仔细画了出来' });
      }
    }

    cand.sort(function (a, b) { return b.p - a.p; });
    var nPick = (level === '优秀' || level === '良好') ? 2 : 1;
    var picked = [], usedKey = {};
    cand.forEach(function (c) {
      if (picked.length < nPick && !usedKey[c.k]) { picked.push(c.t); usedKey[c.k] = 1; }
    });

    var fallback = {
      '优秀': '植物外形完整，茎叶花果的样子都认真画出来了。',
      '良好': '本草主要外形特征画得准确，一眼能认出是什么植物。',
      '合格': '植物外形基本画完整、能够辨认。',
      '待改进': '植物外形还比较简单，可以对照资料把茎叶花果画完整。'
    }[level];

    if (!picked.length) return fallback;
    if (picked.length === 2 && picked[0].length + picked[1].length > 70) {
      return picked[0]; // 避免句子过长
    }
    return picked.join('；') + '。';
  }

  function techniqueComment(f, level) {
    var hasGreen = f && f.greenRatio >= 0.05;
    var hasWarm = f && (f.yellowRatio + f.redRatio) >= 0.03;
    if (level === '优秀') {
      if (hasGreen && hasWarm) return '勾线流畅有轻重，叶片绿色有深浅变化，花朵点染清淡、不压轮廓线，色调贴合植物真实样貌。';
      if (hasGreen) return '勾线流畅，叶片淡彩有明暗层次、颜色通透不压线，整体色调清新自然。';
      return pickRandom(MOCK_COMMENTS.technique['优秀']);
    }
    if (level === '良好') {
      // 色彩饱满又没有重色证据：不存在“涂改/颜色重”，不能用通用模板
      if (f.colorRatio >= 0.15 && f.heavyColorRatio < 0.1) {
        return '勾线流畅肯定，淡彩通透干净，叶片的绿色层次和花朵的清淡点染都处理得很好。';
      }
      return pickRandom(MOCK_COMMENTS.technique['良好']);
    }
    if (level === '合格') {
      // 没有重色糊线证据：不说“盖住勾线”，先肯定再给小建议
      if (f.heavyColorRatio < 0.17) {
        return '勾线和上色都已完成，颜色比较均匀；建议下次上色时笔尖多蘸一点清水、薄薄地铺，颜色会更透明，线条也会更清楚。';
      }
      return pickRandom(MOCK_COMMENTS.technique['合格']);
    }
    return pickRandom(MOCK_COMMENTS.technique['待改进']);
  }

  function cornerNameByCell(idx) { // cell 序号 → 角名
    return ({ 0: '左上角', 2: '右上角', 6: '左下角', 8: '右下角' })[idx];
  }

  function knowledgeComment(f, level, ev) {
    var textIdxs = [0, 2, 6, 8].filter(function (i) {
      var c = f.cells[i];
      return c.isTextArea || c.isTitleArea;
    });
    var titleIdxs = [0, 2, 6, 8].filter(function (i) {
      return f.cells[i].isTitleArea;
    });
    var names = textIdxs.map(cornerNameByCell);
    if (level === '优秀') {
      var titleIdx = titleIdxs[0] != null ? titleIdxs[0] : -1;
      var others = names.filter(function (n) { return n !== cornerNameByCell(titleIdx); });
      var titlePart = titleIdx >= 0
        ? cornerNameByCell(titleIdx) + '的大字标题点明了本草名称'
        : '本草名称标注清楚';
      var rest = others.length
        ? '，' + others.join('与') + '的功效、主治文字信息完整'
        : '，功效文字完整';
      return titlePart + rest + '，书写工整，图文结合得很好。';
    }
    if (level === '良好') {
      return '本草名称书写正确，功效信息基本准确；少量字迹可以再写工整一些。';
    }
    if (level === '合格') {
      if (textIdxs.length <= 1) {
        return '只在' + (names[0] || '一角') + '写出了本草名称，功效介绍还没有补，可以在另一处空白角写一两句功效，并把字写整齐。';
      }
      return '写出了本草名称和少量文字，但功效介绍偏少，建议在空白处补充一两句功效，字再写整齐些。';
    }
    return '画面边缘看不到本草名称和文字介绍，这是必须补做的内容。';
  }

  /* 九宫格序号 → 位置名 */
  var CELL_POS_NAMES = ['左上角', '上方', '右上角', '左侧', '中部', '右侧', '左下角', '下方', '右下角'];

  function joinPositions(list) {
    var uniq = list.filter(function (v, i) { return list.indexOf(v) === i; });
    if (uniq.length <= 2) return uniq.join('和');
    return uniq.slice(0, -1).join('、') + '和' + uniq[uniq.length - 1];
  }

  /* 构图维度评语（中性）：只客观描述画面里植物与文字的位置、主次，
   * 不判定、不命名任何构图类型——构图类型由教师人工在下拉中选择。 */
  function layoutDescription(f, level, ev) {
    if (!f) return '植物绘画与文字介绍都呈现在画面中，可以先把植物与文字的区域划分清楚再动笔。';

    var s = f.subject || {};
    var cx = (s.minX + s.maxX) / 2, cy = (s.minY + s.maxY) / 2;
    var plant;
    if (s.spanX >= 0.8) plant = '植物枝叶横向铺开、占满画面的宽度';
    else if (s.spanY >= 0.8) plant = '植物竖向生长、占据画面大部分高度';
    else {
      var px = cx < 0.33 ? '画面左侧' : cx > 0.67 ? '画面右侧' : '画面中部';
      var py = cy < 0.3 ? '、位置偏上' : cy > 0.7 ? '、位置偏下' : '';
      plant = '植物画在' + px + py;
    }

    var titleIdx = [], textIdx = [], i;
    for (i = 0; i < 9; i++) {
      if (f.cells[i].isTitleArea) titleIdx.push(i);
      else if (f.cells[i].isTextArea) textIdx.push(i);
    }
    var sentences = [plant];
    /* 名称格 ≥3：多为文字行被误判，不逐格列举，改为概括说法 */
    if (titleIdx.length >= 3) {
      sentences.push('本草名称和介绍文字分布在画面多处');
    } else {
      if (titleIdx.length) {
        sentences.push('本草名称大字写在' + joinPositions(titleIdx.map(function (i) { return CELL_POS_NAMES[i]; })));
      }
      var allTextN = titleIdx.length + textIdx.length;
      if (allTextN >= 4) {
        sentences.push('功效文字分布在画面四周');
      } else if (textIdx.length) {
        sentences.push('功效介绍写在' + joinPositions(textIdx.map(function (i) { return CELL_POS_NAMES[i]; })));
      }
    }

    var body = sentences.join('，');

    if (level === '优秀') return body + '，图文各有区域，主体突出、主次清楚，版面干净。';
    if (level === '良好') return body + '，图文分区比较清楚，主体醒目，版面整体舒服。';
    if (level === '合格') {
      var touchEdge = f.paperKinds === 1 &&
        (s.spanX >= 0.95 || s.spanY >= 0.95) &&
        Math.max.apply(null, f.outerFill) >= 0.5;
      if (touchEdge) {
        return body + '，枝叶画到了纸边，可以在四周多留一指宽的空隙。';
      }
      if (ev && ev.outsideInkBlocks <= 4) {
        return body + '，画面空白处还可以再补写一行功效或采摘季节。';
      }
      return body + '。';
    }
    if (f.coverage < 0.12) {
      return '画面中植物与文字都还很少，建议先对照资料把植物外形和名称介绍补齐。';
    }
    return body + '，植物与文字的分区还可以再划分清楚一些。';
  }

  /* 闪光点 → 具体夸赞句（每种闪光点给两种说法，避免多份作业雷同） */
  var HIGHLIGHT_LINES = {
    collage: [
      '用撕纸拼贴把本草衬托出来，两种纸的材质搭配很有想法',
      '把画好的本草撕贴在深色纸上，拼贴手法让画面像古籍册页一样有质感'
    ],
    seal: [
      '红色小印章一盖，整页立刻有了《本草纲目》的古画味道',
      '红色印章点在画面一角，色彩提神，也像真正的本草古籍'
    ],
    frame: [
      '细边框把图文收在一起，整页更精致完整',
      '四周的边框让画面有画册内页的仪式感，版面收得很稳'
    ],
    title: [
      '大字标题写得醒目，和植物、小字介绍分出了清楚的主次',
      '醒目的本草名称大字让版面一眼就能找到主题，设计意识很强'
    ],
    textRich: [
      '功效主治文字整理得齐全，图文结合，能看出“本草记录者”的用心',
      '把搜集到的知识认真写进画面，图文并茂，记录得很完整'
    ],
    darkPaper: [
      '用深色纸做底色，浅色植物被衬托得更突出，配色大胆',
      '深色纸张的底色沉稳，让植物和文字都更显眼'
    ],
    multiHue: [
      '花叶的颜色丰富却不杂乱，看得出上色时的用心',
      '多种色彩搭配和谐，画面饱满好看'
      ]
  };

  function creativityComment(f, level, comp, ev) {
    if (level === '待改进') return pickRandom(MOCK_COMMENTS.creativity['待改进']);
    var hl = extractHighlights(f, comp, ev);
    // 无闪光点：不夸创意，只肯定认真完成，不出现“中规中矩/缺少思考”等扫兴话
    if (!hl.count) return pickRandom(MOCK_COMMENTS.creativity['base']);
    // 随机挑 1~2 个闪光点组合；不同作业闪光点组合不同，评语自然不雷同
    var keys = hl.keys.slice();
    var chosen = [];
    var take = Math.min(keys.length, Math.random() < 0.45 ? 1 : 2);
    while (chosen.length < take) {
      var k = keys.splice(Math.floor(Math.random() * keys.length), 1)[0];
      chosen.push(pickRandom(HIGHLIGHT_LINES[k]));
    }
    var tail = level === '优秀'
      ? '，完成度高，科学记录和自己的想法结合得很好。'
      : '。';
    return chosen.join('；') + tail;
  }

  /* =========================================================
   * 优化建议：证据触发式
   * 1. 主体突出时，绝不挑主体的毛病；
   * 2. 每条必须写清“哪个位置 + 怎么改”，不用学生无从下手的宽泛话；
   * 3. 最多 2 条；画面完整时可以只肯定。
   * ========================================================= */

  /* 找最空的角：按角格覆盖度排序（文字/画面都算） */
  function emptiestCorners(f) {
    return [0, 2, 6, 8].map(function (i) {
      return { i: i, r: f.cells[i].coverage + (f.cells[i].outsideInkRatio || 0) };
    }).sort(function (a, b) { return a.r - b.r; });
  }

  /* 边序号 → 边名 */
  function edgeNameByIdx(idx) {
    return (['上边', '下边', '左边', '右边'])[idx];
  }

  /* 半边框检测：三边框线只缺一边。
   * 守卫：已有边必须是“内缩框线”（最外缘像素线大部分为空），排除植物碰边误报 */
  function halfFrame(f) {
    var presentSides = f.edgeRatios.map(function (r, i) {
      return r >= 0.22 && f.outerFill[i] <= 0.4 ? i : -1;
    }).filter(function (i) { return i >= 0; });
    var missingSides = f.edgeRatios.map(function (r, i) {
      return r < 0.1 ? i : -1;
    }).filter(function (i) { return i >= 0; });
    if (presentSides.length >= 3 && missingSides.length === 1) {
      return '画面的' + presentSides.map(edgeNameByIdx).join('、') +
        '已经有框线，只缺' + edgeNameByIdx(missingSides[0]) +
        '，可以在这一边距纸边约半厘米处补上同样的线条，整圈边框就完整了';
    }
    return null;
  }

  /* 底部是否大面积空白（根部坡地建议的证据） */
  function bottomMostlyEmpty(f) {
    return f.cells[6].coverage < 0.1 && f.cells[7].coverage < 0.06 &&
           f.cells[8].coverage < 0.1;
  }

  /* 画面相关的细化建议：每条都有像素证据，与画面内容直接相关 */
  function contentRefinements(f, ev, hl) {
    var list = [];
    var s = f.subject || {};
    var singlePaper = f.paperKinds === 1;

    // 半边框（证据最强，优先）
    var hf = halfFrame(f);
    if (hf) list.push(hf);

    // 单色画面：按检出的主色给针对性建议，避免与画面已有的花果矛盾
    if (singlePaper && f.hueKinds <= 1 && f.colorRatio >= 0.06) {
      var hueRatios = { red: f.redRatio, green: f.greenRatio, yellow: f.yellowRatio, blue: f.blueRatio, brown: f.brownRatio };
      var topHue = Object.keys(hueRatios).sort(function (a, b) { return hueRatios[b] - hueRatios[a]; })[0];
      if (topHue === 'red') {
        list.push('红色果实（或花朵）颜色饱满，可以在果实互相堆叠、挨得最近的地方，用稍深一点的红色点出前后遮挡，层次会更清楚');
      } else if (topHue === 'yellow') {
        list.push('画面以黄色为主，可以用少量赭石色在花朵下方或叶片边缘加一点深浅变化，再点上几片绿叶，颜色会更耐看');
      } else {
        list.push('整幅以绿色为主，可以再查一查这株本草开什么颜色的花、结什么颜色的果，在枝叶间点出少量花朵或果实，画面会更生动');
      }
    }

    // 枝叶画到纸边：bbox 到边且最外缘像素线确有内容（拼贴/留白近边均排除）
    var touchesEdge = (s.spanX >= 0.95 || s.spanY >= 0.95) &&
                      Math.max.apply(null, f.outerFill) >= 0.5;
    if (singlePaper && touchesEdge) {
      list.push('枝叶已经画到纸的边缘，重画时可以把植物缩小一圈，四周留出约一指宽的空白，画面会更透气');
    }

    // 主体范围内明显稀疏（拼贴画面 fillRate 受撕纸影响，不参与）
    if (singlePaper && s.prominent && s.fillRate < 0.32 &&
        s.spanX < 0.9 && s.spanY < 0.9) {
      list.push('主体范围内枝叶之间空隙较大，可以在空隙处补画两三片小叶子或花苞，本草会显得更茂盛');
    }

    // 文字确实偏少（绘画已完成）：指明补写位置
    if (ev.outsideInkBlocks <= 4 && f.coverage >= 0.3) {
      var ec = emptiestCorners(f);
      list.push('除了名称，还可以在' + cornerNameByCell(ec[0].i) +
        '的空白处补写一行功效或采摘季节，文字介绍会更完整');
    }
    return list;
  }

  /* 画面无硬问题时：只给 1 条。
   * 候选“画面内容优先”，由画面特征确定性选取，不同作品不会落到同一句 */
  function singleEnrichment(f, ev, hl) {
    var ec = emptiestCorners(f);
    var emptyCorner = cornerNameByCell(ec[0].i);
    /* 每条候选带“需求分”：画面越缺什么，对应建议分越高 → 取最高分 */
    var candidates = [], deco = [];
    var fr = (f.subject && f.subject.fillRate) || 0;

    if (bottomMostlyEmpty(f)) {
      candidates.push({ s: 0.95, text: '可以在植物根部用淡墨画一小条坡地或几簇小草，让本草像从泥土里长出来一样' });
    }
    if (f.colorRatio >= 0.08) {
      candidates.push({ s: f.colorRatio * 3, text: '可以挑画面上最大的两三片叶子，用稍深一点的同色勾出主叶脉，叶片会更有层次' });
      candidates.push({ s: (1 - fr) * 0.7 + f.colorRatio * 0.5, text: '可以在枝条顶端再点几个还没开放的小花苞，整株本草会更有生机' });
      candidates.push({ s: f.hueKinds <= 2 ? 0.8 : 0.2, text: '可以给两三片叶子的叶尖加一点点赭石色，表现老叶和枯叶，本草看起来更真实' });
    }
    if (f.subject && f.subject.prominent && fr < 0.7 && fr >= 0.2) {
      candidates.push({ s: 0.7 - fr, text: '可以在枝条转弯、叶片较稀疏的位置再补一片小叶子，枝叶的疏密会更自然' });
    }
    // —— 装饰类：仅在无内容类候选时兜底，已有的不再提 ——
    if (!hl.seal) {
      deco.push('可以在' + emptyCorner + '的空白处画（或盖）一枚指甲盖大小的红色姓名印章，像真正的本草古籍');
    }
    if (!hl.title && !ev.hasTitle) {
      deco.push('可以在' + emptyCorner + '用大号字写出本草名称，字周围留一圈白边，标题会很醒目');
    }
    if (!hl.frame) {
      deco.push('可以沿四条边、距纸边约半厘米处用细笔勾一圈直线边框，把图画和文字收在一起');
    }

    if (candidates.length) {
      candidates.sort(function (a, b) { return b.s - a.s; });
      return candidates[0].text;
    }
    if (deco.length) return deco[0];
    return null;
  }

  function buildSuggestions(f, comp, ev) {
    if (!f) return ['保持现在的完成度，可以再细化一两处叶片或叶脉的线条。'];

    /* 大面积未完成：只给一条最优先的建议 */
    if (f.coverage < 0.12) {
      return ['画面内容还很少，建议先对照资料把植物完整外形画出来，再勾线、上色，最后在空白处写上名称和一两句功效。'];
    }

    var out = [];
    function push(s) { if (s && out.indexOf(s) < 0) out.push(s); }

    var prominent = f.subject && f.subject.prominent;
    var hl = extractHighlights(f, comp, ev);

    /* A. 真实硬问题（证据触发）：主体不突出 / 重色糊线 / 无线描色彩 / 无文字 */
    if (!prominent && f.coverage < 0.28) {
      push('画面中的植物形象偏小，可以把它再放大重画一遍，让枝叶占到画面一半以上，看起来会更大方醒目。');
    }
    if (f.heavyColorRatio >= 0.17) {
      push('局部颜色偏重、盖住了勾线，建议用干净的清水笔轻轻扫过过重处把颜色带淡，之后上色先铺浅色、干透后再加深。');
    } else if (f.colorRatio < 0.03 && f.coverage >= 0.25) {
      push('画面目前只有线描，可以调很淡的绿色和黄色，先给叶片和花瓣各铺一层浅底色，颜色干了以后再在少数地方加深。');
    }
    if (ev.textCorners === 0 && f.coverage >= 0.25) {
      var ec0 = emptiestCorners(f);
      push('在' + cornerNameByCell(ec0[0].i) + '写上本草的名称，再在它旁边用一两句话写出它的功效，画面的图文就完整了。');
    }

    /* B. 画面相关细化建议（最多补到 2 条，不硬凑） */
    if (out.length < 2) {
      var refs = contentRefinements(f, ev, hl);
      for (var i = 0; i < refs.length && out.length < 2; i++) push(refs[i]);
    }

    /* C. 仍无建议：只给 1 条与画面相关的建议 */
    if (!out.length) {
      push(singleEnrichment(f, ev, hl) ||
           '画面主体醒目、图文完整，没有必须修改的地方，继续保持认真观察。');
    }
    return out.slice(0, 2);
  }

  /* =========================================================
   * 组装评价结果
   * ========================================================= */
  /* 总评：由画面事实组合而成，不用放之四海皆准的固定模板 */
  function buildOverall(f, comp, ev, level, dimLevels) {
    if (!f) return OVERALL_COMMENTS[level];
    var parts = [];
    // 基础肯定：完成了“搜集资料 → 画样貌 → 配介绍”的任务
    parts.push('本草样貌和基本介绍都完整呈现出来了');
    var hl = extractHighlights(f, comp, ev);
    var overallLines = {
      collage: '撕纸拼贴的材质搭配很有想法',
      seal: '红色小印章让画面有古籍味道',
      frame: '边框让版面更精致完整',
      title: '大字标题醒目、主次清楚',
      textRich: '功效主治文字整理得齐全',
      darkPaper: '深色纸把植物衬托得很突出',
      multiHue: '花叶色彩丰富和谐'
    };
    if (hl.count) {
      var picked = hl.keys.slice(0, 3).map(function (k) { return overallLines[k]; });
      parts.push(picked.join('，'));
    }
    var body = parts.join('；') + '。';

    if (level === '优秀') return body + '整页体现了本草图谱科学记录与艺术表现的结合，继续保持！';
    if (level === '良好') return body + '保持这样的认真，下次可以试试印章或边框让画册更精致，继续加油！';
    if (level === '合格') {
      // 只点真正薄弱的维度，已完成的不说“补完整”
      var weak = [];
      if (dimLevels) {
        if (dimLevels.shape === '待改进') weak.push('植物外形可以对照资料再画细致一些');
        if (dimLevels.technique === '待改进') weak.push('勾线和上色可以再匀净一些');
        if (dimLevels.layout === '待改进') weak.push('图文排布可以参考课堂学过的版式再调整');
        if (dimLevels.knowledge === '待改进') weak.push('名称和功效介绍可以再补完整');
      }
      if (!weak.length) weak.push('可以再细化一两处叶片或叶脉的线条');
      return body + weak.join('；') + '，再考虑加印章、边框等小设计。';
    }
    return body + '建议先补齐画面与文字，老师期待你的修改。';
  }

  function buildObservedResult(f) {
    var comp, ev;
    if (f) {
      comp = detectComposition(f);
      ev = knowledgeEvidence(f);
    } else {
      comp = { name: pickRandom(BASIC_COMPOSITIONS), confidence: 0.6 };
      ev = { cornerInk: [], textCorners: 0, hasTitle: false };
    }

    var levels = {
      shape: assessShape(f),
      technique: assessTechnique(f),
      layout: assessLayout(comp, f, ev),
      knowledge: assessKnowledge(f, ev),
      creativity: assessCreativity(f, comp, ev)
    };

    var dimensions = DIMENSIONS.map(function (d) {
      var level = levels[d.key];
      var item = {
        key: d.key, name: d.name, weight: d.weight,
        level: level, score: LEVEL_SCORE[level]
      };
      if (d.key === 'layout') {
        item.composition = comp.name || COMPOSITION_NONE;
        // 评语不判定构图类型，只客观描述画面；构图类型由教师人工修改
        item.comment = layoutDescription(f, level, ev);
      } else if (d.key === 'shape') {
        item.comment = shapeComment(f, level);
      } else if (d.key === 'technique') {
        item.comment = techniqueComment(f, level);
      } else if (d.key === 'knowledge') {
        item.comment = f ? knowledgeComment(f, level, ev)
                         : pickRandom(MOCK_COMMENTS.knowledge[level] || MOCK_COMMENTS.knowledge['合格']);
      } else {
        item.comment = creativityComment(f, level, comp, ev);
      }
      return item;
    });

    var totalScore = computeScore(dimensions);
    var overallLevel = levelFromScore(totalScore);

    return {
      dimensions: dimensions,
      suggestions: buildSuggestions(f, comp, ev),
      totalScore: totalScore,
      overallLevel: overallLevel,
      overallComment: buildOverall(f, comp, ev, overallLevel, levels)
    };
  }

  function gradeMock(image) {
    var delay = 1200 + Math.random() * 900;
    var work;
    if (image) {
      work = analyzeImage(image).then(
        function (f) { return buildObservedResult(f); },
        function () { return buildObservedResult(null); }
      );
    } else {
      work = Promise.resolve(buildObservedResult(null));
    }
    return new Promise(function (resolve) {
      work.then(function (result) {
        setTimeout(function () { resolve(result); }, delay);
      });
    });
  }

  /* =========================================================
   * 真实 AI 批改（OpenAI 兼容 chat/completions，图片 base64）
   * ========================================================= */
  var PROMPT = [
    '你是小学美术“本草画册作业”的专业评阅助手，请严格依据下面的本草作业评价标准，对上传的本草画册单页内页照片进行评判。',
    '评价对象包含：本草植物写生绘画 + 本草文字介绍 + 版面排版。只依据图片中真实可见的内容评价；看不清的内容要如实说明，禁止编造作品概述。',
    '',
    '【观察与评分态度——最重要】',
    '1. 先花时间真正看懂画面：画了什么植物、茎叶花怎么长的、用了什么颜色和线条、文字写在哪、版面怎么安排，然后再打分。评语必须引用画面中真实可见的细节（如“叶片画出了正反面的颜色变化”），禁止与画面无关的空泛套话。',
    '2. 每个维度都要先找出学生做到的优点，再指出不足。这是小学生的手绘作业，不应以成人或印刷品的完美标准苛求。',
    '3. 评分锚点：认真完成、画面内容完整的作业，各维度基线在“合格”偏上，总分通常不低于70分；造型生动、色彩构图讲究的作品应给85分以上；只有画面大面积空白、未完成或完全看不出植物形态时，才给“待改进”或低分。严禁未经细看就随意给低分。',
    '4. 评语中禁止指出画面上并不存在的问题（例如画面明明有本草名称却说“缺少名称”）。',
    '',
    '【五个评价维度与四级标准】',
    '1. 写生造型（权重30%）',
    ' 优秀：抓住中草药典型外形特征，叶片前后遮挡、翻转姿态表现到位，茎叶形态自然生动，体现观察成果。',
    ' 良好：能表现本草主要外形特征，大部分叶片形态准确，少量遮挡关系未表现。',
    ' 合格：画出植物大体外形、能辨认草药种类，学生达到了基础要求；不足只温和提醒，不使用“细节缺失较多”等重话。',
    ' 待改进：植物形态难以辨认，没有表现本草基本外形。',
    ' 【造型评语规则——重要】评语必须写出这张画里真实可见的具体细节与亮点，例如“每颗枇杷顶端的星形果脐都点画出来了”“银杏叶扇形叶片上的放射状叶脉画得清楚”“几十颗红色小果实成串堆叠、疏密自然”“喇叭形花朵有盛开和花苞两种姿态”“根须交错画出”。不同作业的评语必须不同。',
    ' 严禁所有作业都写“外形和颜色都画出来了、再看看叶片朝向、画翻转和遮挡”这类雷同套话；如果画面上确实没有值得一提的细节，只写一句简短的话即可，不要硬凑。',
    '2. 线描色彩技法（权重20%）',
    ' 优秀：线条流畅有轻重变化；淡彩通透，不遮盖轮廓线，色彩贴合植物真实色调。',
    ' 良好：线条整体流畅，少量涂改；淡彩基本清淡，局部颜色偏重，轮廓线基本保留。',
    ' 合格：轮廓线完整，上色完成，部分区域颜色过重，少量盖住勾线。',
    ' 待改进：线条杂乱难以辨认，上色大面积糊掉，破坏轮廓。',
    '3. 图文排版构图（权重20%）',
    ' 优秀：构图饱满舒适，本草绘画为画面主体；图文主次分明，文字位置合理，版面干净美观。',
    ' 良好：构图完整，绘画主体突出；图文位置基本合适，少量文字挤压画面。',
    ' 合格：图画文字均摆放于版面，图文比例略有失衡，可以作为画册内页使用。',
    ' 待改进：构图拥挤或太空旷，图文互相重叠，版面混乱。',
    ' 【构图评语规则——重要】',
    ' composition 字段：给出你对构图类型的判断，只能从以下术语中选择，不得自造名词：课堂基础版式「上下式、对角式、左右式、中心发散式」；拓展版式「居中构图、四角构图、对称构图、S形曲线构图、散点构图、包围式构图」；无法判断时填「未使用明确的构图版式」。该字段仅供教师参考，教师通常会人工修改。',
    ' comment 字段：禁止在评语中判定或命名构图类型（即不要写“采用对角式/左右式/包围式构图”等），只客观描述画面内容：植物画在画面什么位置、枝叶怎样伸展，名称和功效文字写在什么位置，图文主次是否清楚。',
    '4. 本草知识文本（权重15%）',
    ' 优秀：中草药名称标注准确；功效介绍简洁正确，文字书写工整。',
    ' 良好：本草名称书写正确；功效信息基本无误，书写较工整。',
    ' 合格：有本草名称，功效内容简单，文字潦草。',
    ' 待改进：缺少植物名称，无本草相关文字介绍。',
    '5. 作品完整度与创意（权重15%）',
    ' 本节课的作业本质是“搜集本草信息→画出本草样貌+基本介绍”，学生达到基础要求就应给予肯定。',
    ' 优秀：整页作业全部完成；并在画面内容与文字之外有真实可见的用心之处（如撕纸拼贴、红色印章、细边框、醒目的大字标题、文字整理齐全等）。',
    ' 良好：作业全部完成、认真清楚，即使没有额外设计也应给良好。',
    ' 合格：基本完成课堂作业，完成了基础任务。',
    ' 待改进：作业大面积未完成，没有达到基础创作要求。',
    ' 注意：闪光点要画面里真实存在才夸，没有就不夸；禁止使用“中规中矩”“缺少思考”这类扫兴、否定认真态度的话。',
    '',
    '【输出要求】只输出一个 JSON 对象，不要输出 JSON 以外的任何内容，不要使用代码块。JSON 结构如下：',
    '{',
    '  "dimensions": [',
    '    {"key":"shape","level":"等级","comment":"写画面真实可见的具体细节亮点，禁止套话，20~60字"},',
    '    {"key":"technique","level":"等级","comment":"简短评价结论"},',
    '    {"key":"layout","composition":"你判断的构图名称（供教师修改）","level":"等级","comment":"不命名构图，只客观描述植物与文字的位置、主次，20~60字"},',
    '    {"key":"knowledge","level":"等级","comment":"简短评价结论"},',
    '    {"key":"creativity","level":"等级","comment":"简短评价结论"}',
    '  ],',
    '  "suggestions": ["改进建议"],',
    '  "overallComment": "简短整体评语，30~80字",',
    '}',
    '其中“等级”只能填：优秀 / 良好 / 合格 / 待改进。',
    '',
    '【suggestions 改进建议的硬性规则】',
    '1. 严格最多2条，画面已经很好时可以只写1条，甚至只给肯定、不提修改。',
    '2. 每条必须针对画面中真实存在、肉眼可见的问题，写清“画面哪个位置 + 具体怎么改”，例如“画面右下角留白较多，可在该位置补写一行金银花的功效，与左侧标题呼应”。',
    '3. 严禁万能套话，尤其禁止出现“用白色颜料小心遮盖”“用小装饰图案巧妙化解”这类对任何作业都适用、学生无法操作的空话。',
    '4. 严禁建议修改画面上并不存在的问题；画面主体已经突出时，禁止再提“主体偏小/主体不突出”等主体缺点。建议要少而精，宁缺毋滥。',
    '5. 如果画面没有必须修改的问题，可以提“画面内容与文字之外”的加分项建议，并同样写清位置与做法。',
    '6. 所有作业都给出“印章、边框”两条建议是严重错误：优先提与画面内容直接相关的建议（如补画叶脉、花苞、花朵果实的真实颜色、根部坡地、在特定空白处补写功效），实在无话可说时只给1条；必须逐张观察画面，不同作业的建议不得雷同。'
  ].join('\n');

  function toLevel(raw) {
    if (!raw) return null;
    var s = String(raw).trim().toUpperCase();
    if (s.indexOf('优秀') >= 0 || s === 'A') return '优秀';
    if (s.indexOf('良好') >= 0 || s === 'B') return '良好';
    if (s.indexOf('合格') >= 0 || s === 'C') return '合格';
    if (s.indexOf('待改进') >= 0 || s.indexOf('待') >= 0 || s === 'D') return '待改进';
    return null;
  }

  function cleanStr(s) {
    return String(s == null ? '' : s).trim();
  }

  function extractJSON(text) {
    var t = String(text).trim();
    t = t.replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
    var start = t.indexOf('{'), end = t.lastIndexOf('}');
    if (start < 0 || end <= start) throw new Error('AI 返回内容不是有效 JSON');
    return JSON.parse(t.slice(start, end + 1));
  }

  /* 将 AI 返回统一为标准结构，缺项补默认值 */
  function normalize(obj) {
    var rawDims = obj.dimensions || [];
    var byKey = {};
    rawDims.forEach(function (r) { if (r && r.key) byKey[String(r.key)] = r; });

    var dimensions = DIMENSIONS.map(function (d, i) {
      var r = byKey[d.key] || rawDims[i] || {};
      var level = toLevel(r.level) || '合格';
      var item = {
        key: d.key, name: d.name, weight: d.weight,
        level: level, score: LEVEL_SCORE[level],
        comment: cleanStr(r.comment) || '该维度评价内容缺失。'
      };
      // 构图维度：只接受课件术语，自造或缺失置空由教师补选
      if (d.key === 'layout') {
        item.composition = isValidComposition(r.composition) ? cleanStr(r.composition) : '';
      }
      return item;
    });

    var suggestions = (obj.suggestions || [])
      .map(cleanStr)
      .filter(Boolean)
      .slice(0, 2); // 建议硬性上限 2 条
    if (!suggestions.length) suggestions = ['画面完成度已经很好，继续保持细致观察的好习惯。'];

    var totalScore = computeScore(dimensions);

    return {
      dimensions: dimensions,
      suggestions: suggestions,
      totalScore: totalScore,
      overallLevel: levelFromScore(totalScore), // 总分与总等级保持一致
      overallComment: cleanStr(obj.overallComment) || OVERALL_COMMENTS[levelFromScore(totalScore)]
    };
  }

  function apiErrorMessage(data, status) {
    var msg = data && data.error && data.error.message;
    if (status === 401) return 'API Key 无效或已过期，请检查设置';
    if (status === 404) return '接口地址或模型名称不正确，请检查设置';
    if (status === 429) return '调用过于频繁或免费额度已用完';
    if (status === 400) return '请求被拒绝：' + (msg || '参数有误');
    return '接口返回错误（HTTP ' + status + (msg ? '：' + msg : '') + '）';
  }

  function gradeReal(image, cfg) {
    function attempt(model) {
      var body = {
        model: model,
        temperature: 0.3,
        messages: [{
          role: 'user',
          content: [
            { type: 'image_url', image_url: { url: image } },
            { type: 'text', text: PROMPT }
          ]
        }]
      };

      return fetch(cfg.endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer ' + cfg.apiKey
        },
        body: JSON.stringify(body)
      }).then(function (res) {
        return res.text().then(function (text) {
          var data;
          try { data = JSON.parse(text); }
          catch (e) { throw new Error('接口返回了无法识别的内容（HTTP ' + res.status + '）'); }

          // 模型拥挤（免费 flash 高发）：抛特殊错误，由外层换模型重试
          if (res.status === 429) {
            var busy = new Error('MODEL_BUSY');
            busy.busy = true;
            throw busy;
          }
          if (!res.ok) throw new Error(apiErrorMessage(data, res.status));

          var content = data.choices && data.choices[0] &&
            data.choices[0].message && data.choices[0].message.content;
          if (!content) throw new Error('AI 没有返回有效评价内容');

          return normalize(extractJSON(content));
        });
      });
    }

    // 首选模型拥挤时：等 3 秒重试一次，仍拥挤则依次自动换
    // glm-4.6v（更便宜）、glm-4.5v
    function wait(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
    var fallbackModels = ['glm-4.6v', 'glm-4.5v'];
    function fallback(idx) {
      if (idx >= fallbackModels.length) {
        return Promise.reject(new Error('AI 服务器当前繁忙，请稍等几分钟再重新批改这份作业'));
      }
      var m = fallbackModels[idx];
      if (m === cfg.model) return fallback(idx + 1);
      return attempt(m).catch(function (e) {
        if (e && e.busy) return fallback(idx + 1);
        throw e;
      });
    }
    return attempt(cfg.model).catch(function (err) {
      if (!err || !err.busy) throw err;
      return wait(3000).then(function () { return attempt(cfg.model); }).catch(function (err2) {
        if (!err2 || !err2.busy) throw err2;
        if (cfg.provider === 'zhipu') return fallback(0);
        throw err2;
      });
    }).catch(function (err) {
      if (err instanceof TypeError) {
        throw new Error('无法连接接口：可能是网络问题，或浏览器跨域(CORS)限制，可尝试填写代理地址');
      }
      throw err;
    });
  }

  /* 统一入口 */
  function grade(image, cfg) {
    if (cfg && cfg.mode === 'real' && cfg.apiKey && cfg.endpoint && cfg.model) {
      return gradeReal(image, cfg);
    }
    return gradeMock(image);
  }

  global.AI = {
    LEVELS: LEVELS,
    DIMENSIONS: DIMENSIONS,
    PROVIDERS: PROVIDERS,
    RUBRIC: RUBRIC,
    LEVEL_SCORE: LEVEL_SCORE,
    COMPOSITION_DEFS: COMPOSITION_DEFS,
    BASIC_COMPOSITIONS: BASIC_COMPOSITIONS,
    EXTENDED_COMPOSITIONS: EXTENDED_COMPOSITIONS,
    COMPOSITION_NONE: COMPOSITION_NONE,
    isValidComposition: isValidComposition,
    getCompositionDef: getCompositionDef,
    computeScore: computeScore,
    levelFromScore: levelFromScore,
    levelClass: levelClass,
    grade: grade,
    normalize: normalize
  };
})(window);
