/* 卫生许可个人业务工作台 — 应用逻辑
 * 数据源：window.SEED_DATA（来自《zyf test.xlsx》）
 * 所有页面共享同一套本地数据（localStorage），并可选同步到 Supabase。
 */
(function(){
  "use strict";

  var LS_DATA = "hp_workbench_data_v2";
  var LS_SETTINGS = "hp_workbench_settings";
  // 内置默认配置（开箱即用；如需清除请在「设置界面」留空并保存）
  var DEFAULT_SETTINGS = {
    amapKey:"78b6849a32ebdb6c5db2371b3eb3a732",
    amapSecurity:"c930ea76af4fe01a9ab82e82ca85b3b2",
    supabaseUrl:"https://tchrevgamfaxjmjcqeww.supabase.co",
    supabaseKey:"sb_publishable_WDg9H-OEl5ickKrRqQpcfQ_qVFk_oM1",
    supabaseTable:"units"
  };

  var state = {
    data: [],
    settings: Object.assign({}, DEFAULT_SETTINGS),
    view: "home",
    homeWindow: 30,
    selected: {},          // uid -> true
    amap: null,
    geocoder: null,
    amapReady: false,
    markers: {},           // uid -> AMap.Marker
    pickMode: false,        // 地图手动选点模式
    pickTarget: null,       // 选点目标单位 uid
    searchActive: false,    // 是否处于搜索高亮状态
    searchMatches: {},      // uid -> true（搜索命中集合）
    searchJustRan: false,   // 本次搜索刚触发（用于播放一次跳动）
    mapQuery: "",           // 地图当前搜索词
    ledgerQuery: ""         // 台账搜索词
  };

  /* ---------------- 工具函数 ---------------- */
  function uid(){ return "u" + Math.random().toString(36).slice(2,9) + Date.now().toString(36); }
  function $(id){ return document.getElementById(id); }
  function sleep(ms){ return new Promise(function(r){ setTimeout(r, ms); }); }
  function esc(s){ return String(s==null?"":s).replace(/[&<>"']/g, function(c){
    return {"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#39;"}[c]; }); }

  function iso(d){
    return d.getFullYear() + "-" + String(d.getMonth()+1).padStart(2,"0") + "-" + String(d.getDate()).padStart(2,"0");
  }
  function parseDate(s){
    if(!s) return null;
    var m = String(s).match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if(!m) return null;
    return new Date(+m[1], +m[2]-1, +m[3]);
  }
  // 有效期止 = 所选日期 + 4 年 - 1 天
  function calcValidTo(fromStr){
    var d = parseDate(fromStr);
    if(!d) return "";
    var nd = new Date(d.getFullYear()+4, d.getMonth(), d.getDate());
    nd.setDate(nd.getDate()-1);
    return iso(nd);
  }
  function daysUntil(s){
    var d = parseDate(s);
    if(!d) return null;
    var t = new Date(); t.setHours(0,0,0,0);
    return Math.round((d - t) / 86400000);
  }
  function normDateStr(v){
    v = String(v==null?"":v).trim();
    if(!v) return "";
    var m = v.match(/^(\d{4})[\/\-\.](\d{1,2})[\/\-\.](\d{1,2})$/);
    if(m) return iso(new Date(+m[1], +m[2]-1, +m[3]));
    return v;
  }
  function normExcelDate(v){
    if(v==null || v==="") return "";
    if(v instanceof Date) return iso(v);
    if(typeof v === "number"){
      // Excel 序列号（1900 日期系统）
      var d = new Date((v - 25569) * 86400000);
      return isNaN(d) ? "" : iso(d);
    }
    return normDateStr(v);
  }
  function nextId(){
    var max = 0;
    state.data.forEach(function(r){
      var n = parseInt(r.id, 10);
      if(!isNaN(n) && n > max) max = n;
    });
    return String(max + 1);
  }
  function coordText(r){
    return (r.lng!=null && r.lat!=null) ? (r.lng.toFixed(5)+", "+r.lat.toFixed(5)) : "未编码";
  }

  /* ---------------- 持久化 ---------------- */
  function loadSettings(){
    // 内置默认（含密钥）作为基础值，仅当用户在某字段填了非空值时才覆盖；
    // 空值不再清空密钥，避免“先存了部分配置”导致后续密钥无法生效。
    state.settings = Object.assign({}, DEFAULT_SETTINGS);
    try{
      var raw = localStorage.getItem(LS_SETTINGS);
      if(raw){
        var parsed = JSON.parse(raw);
        Object.keys(parsed).forEach(function(k){
          if(parsed[k] !== undefined && parsed[k] !== "") state.settings[k] = parsed[k];
        });
      } else {
        // 首次运行：把内置默认（含密钥）固化到本地，真正“配置进去”
        saveSettingsLocal();
      }
    }catch(e){}
  }
  function saveSettingsLocal(){
    localStorage.setItem(LS_SETTINGS, JSON.stringify(state.settings));
  }
  function loadData(){
    var raw = localStorage.getItem(LS_DATA);
    if(raw){
      try{ state.data = JSON.parse(raw); }catch(e){ state.data = []; }
    }
    if(!state.data || !state.data.length){
      state.data = (window.SEED_DATA||[]).map(function(r){
        return Object.assign({}, r, { _uid: uid(), remark:(r.remark||"") });
      });
      saveDataLocal();
    } else {
      state.data.forEach(function(r){ if(!r._uid) r._uid = uid(); if(r.remark===undefined) r.remark=""; });
    }
  }
  function saveDataLocal(){ localStorage.setItem(LS_DATA, JSON.stringify(state.data)); }
  function saveData(sync){
    saveDataLocal();
    if(sync !== false) scheduleSync();
  }

  /* ---------------- 云同步（Supabase） ---------------- */
  var sbClient = null;
  function getSb(){
    if(!state.settings.supabaseUrl || !state.settings.supabaseKey) return null;
    if(!sbClient && window.supabase){
      sbClient = window.supabase.createClient(state.settings.supabaseUrl, state.settings.supabaseKey);
    }
    return sbClient;
  }
  function toRows(){
    return state.data.map(function(r){
      return {
        license:r.license, id:r.id, name:r.name, address:r.address,
        valid_from:r.validFrom, valid_to:r.validTo, lng:r.lng, lat:r.lat,
        remark:r.remark||"",
        deleted: r.deleted ? 1 : 0
      };
    });
  }
  // 是否因“缺少 remark 列”报错（PostgREST 42703 / 含 remark 的 column does not exist）
  function isRemarkColumnError(err){
    if(!err) return false;
    if(err.code === "42703") return true;
    var m = (err.message||"") + " " + (err.hint||"");
    return m.indexOf("remark") >= 0 && (m.indexOf("does not exist") >= 0 || m.indexOf("column") >= 0);
  }
  async function pushCloud(silent){
    var c = getSb();
    if(!c){ if(!silent) toast("请先在设置中配置 Supabase", "warn"); return; }
    try{
      var rows = toRows();
      var res = await c.from(state.settings.supabaseTable).upsert(rows, { onConflict:"license" });
      if(res.error){
        // 若 units 表尚未创建 remark 列，去掉备注后重试，保证其余字段仍同步
        if(isRemarkColumnError(res.error)){
          var rows2 = rows.map(function(r){ var x = Object.assign({}, r); delete x.remark; return x; });
          var res2 = await c.from(state.settings.supabaseTable).upsert(rows2, { onConflict:"license" });
          if(res2.error) throw res2.error;
          if(!silent) toast("已上传 "+rows2.length+" 条（备注列尚未创建，备注暂未同步）", "warn");
          return;
        }
        throw res.error;
      }
      if(!silent) toast("已上传 "+rows.length+" 条到云端", "ok");
    }catch(e){
      if(!silent) toast("上传失败：" + (e.message||e), "err");
    }
  }
  // 云端软删除：用 deleted 标记而非硬删，这样其他设备拉取时能看到“该删了”并同步移除
  // （硬删会导致某台设备本地副本无法被通知删除，多设备间删除无法传播）
  async function deleteCloud(licenses, silent){
    var c = getSb();
    if(!c || !licenses || !licenses.length) return;
    try{
      var res = await c.from(state.settings.supabaseTable)
        .update({deleted:true}).in("license", licenses);
      if(res.error) throw res.error;
      if(!silent) toast("已同步删除标记到云端 "+licenses.length+" 条", "ok");
    }catch(e){
      if(!silent) toast("云端删除失败：" + (e.message||e), "err");
    }
  }
  var syncTimer = null;
  function scheduleSync(){
    if(syncTimer) clearTimeout(syncTimer);
    syncTimer = setTimeout(function(){ pushCloud(true); }, 1500);
  }
  // 从云端拉取。opts: { confirm:是否先确认覆盖, merge:按许可证号合并(保留本地独有记录、坐标不空覆盖),
  //                  quietError:静默错误提示, silent:静默全部提示 }
  async function pullCloud(opts){
    opts = opts || {};
    var c = getSb();
    if(!c){ if(!opts.silent) toast("请先在设置中配置 Supabase", "warn"); return; }
    if(opts.confirm !== false && opts.merge !== true){
      if(!confirm("从云端拉取将用云端数据覆盖本地全部记录，确定继续？")) return;
    }
    try{
      var res = await c.from(state.settings.supabaseTable).select("*");
      if(res.error) throw res.error;
      var rows = res.data || [];
      if(opts.merge === true){
        // 合并模式：云端优先；云端标记为删除的记录也要在本机删除，使删除在设备间传播
        var cloudDeleted = {};
        rows.forEach(function(d){ if(d.deleted) cloudDeleted[d.license] = true; });
        if(Object.keys(cloudDeleted).length){
          state.data = state.data.filter(function(r){ return !cloudDeleted[r.license]; });
        }
        var byLicense = {};
        state.data.forEach(function(r){ if(r.license) byLicense[r.license] = r; });
        rows.forEach(function(d){
          if(d.deleted) return;
          var base = byLicense[d.license];
          if(base){
            base.id = d.id; base.name = d.name; base.address = d.address;
            base.validFrom = d.valid_from; base.validTo = d.valid_to; base.remark = (d.remark||"");
            base.deleted = false;
            if(d.lng != null) base.lng = d.lng;
            if(d.lat != null) base.lat = d.lat;
          } else {
            state.data.push({ _uid: uid(), id:d.id, name:d.name, address:d.address, license:d.license,
              validFrom:d.valid_from, validTo:d.valid_to, lng:d.lng, lat:d.lat, remark:(d.remark||""), deleted:false });
          }
        });
      } else {
        state.data = rows.filter(function(d){ return !d.deleted; }).map(function(d){
          return { _uid: uid(), id:d.id, name:d.name, address:d.address, license:d.license,
            validFrom:d.valid_from, validTo:d.valid_to, lng:d.lng, lat:d.lat, remark:(d.remark||""), deleted:false };
        });
      }
      saveDataLocal();
      renderCurrentView();
      if(rows.length) toast("已从云端同步 "+rows.length+" 条"+(opts.merge?"（已与本地合并）":""), "ok");
    }catch(e){
      if(!opts.quietError && !opts.silent) toast("拉取失败：" + (e.message||e), "err");
    }
  }

  /* ---------------- 高德地图 ---------------- */
  function loadAmapScript(key, security){
    return new Promise(function(resolve, reject){
      if(window.AMap){ resolve(); return; }
      window._AMapSecurityConfig = { securityJsCode: security || "" };
      var s = document.createElement("script");
      s.src = "https://webapi.amap.com/maps?v=2.0&key=" + encodeURIComponent(key) +
              "&plugin=AMap.Geocoder,AMap.ToolBar,AMap.Scale";
      s.onload = function(){ resolve(); };
      s.onerror = function(){ reject(new Error("脚本加载失败（检查网络或密钥）")); };
      document.head.appendChild(s);
    });
  }
  async function ensureAmap(){
    if(state.amapReady) return true;
    if(!state.settings.amapKey){
      return false;
    }
    try{
      await loadAmapScript(state.settings.amapKey, state.settings.amapSecurity);
      state.geocoder = new window.AMap.Geocoder({ city:"北京", citylimit:false });
      state.amapReady = true;
      return true;
    }catch(e){
      toast("高德地图加载失败：" + e.message, "err");
      return false;
    }
  }
  function initMap(){
    var el = $("amap-container");
    if(!state.amap){
      state.amap = new window.AMap.Map(el, { zoom:12, center:[116.41,39.95] });
      state.amap.addControl(new window.AMap.ToolBar());
      state.amap.addControl(new window.AMap.Scale());
      state.amap.on("click", onMapClick);   // 仅在地图创建时绑定一次，避免重复监听
    }
    placeMarkers();
  }
  function placeMarkers(){
    if(!state.amap) return;
    Object.keys(state.markers).forEach(function(k){ state.markers[k].setMap(null); });
    state.markers = {};
    state.data.forEach(function(rec){
      if(rec.lng==null || rec.lat==null) return;
      // 圆形标记；搜索高亮/跳动直接写入内容 class，保证稳定生效
      var cls = "mk-dot";
      if(state.searchActive){
        if(state.searchMatches[rec._uid]){
          cls += " hl";
          if(state.searchJustRan) cls += " bounce";
        } else cls += " dim";
      }
      var marker = new window.AMap.Marker({
        position:[rec.lng, rec.lat],
        anchor:"center",
        title:rec.name,
        zIndex:10,
        content:'<div class="'+cls+'" title="'+esc(rec.name)+'" data-uid="'+rec._uid+'"></div>',
        extData:{ uid:rec._uid }
      });
      marker.on("click", function(){
        if(state.pickMode) pickMarkerChosen(rec._uid);
        else openDetail(rec._uid);
      });
      marker.setMap(state.amap);
      state.markers[rec._uid] = marker;
    });
    state.searchJustRan = false;   // 本次搜索的跳动只播放一次
    updateMapCount();
  }
  function updateMapCount(){
    var cnt = Object.keys(state.markers).length;
    var el = $("map-count");
    if(el) el.textContent = state.searchActive ? ("命中 "+Object.keys(state.searchMatches).length+" 个") : ("共 "+cnt+" 个点位");
  }
  // 搜索：高亮匹配项（跳动）+ 其余淡化，并缩放地图以显示全部结果
  function performSearch(q){
    var box = $("map-suggest");
    if(box){ box.style.display = "none"; box.innerHTML = ""; }
    q = (q||"").trim().toLowerCase();
    if(!q){
      state.searchActive = false; state.searchMatches = {}; state.searchJustRan = false;
      placeMarkers();
      var c = $("map-count"); if(c) c.textContent = "共 "+Object.keys(state.markers).length+" 个点位";
      return;
    }
    var matched = {};
    state.data.forEach(function(rec){
      var hit = (rec.name + rec.address + rec.license).toLowerCase().indexOf(q) >= 0;
      if(hit){ matched[rec._uid] = true; }
    });
    state.searchActive = true;
    state.searchMatches = matched;
    state.searchJustRan = true;     // 触发一次跳动
    placeMarkers();                 // 重建标记，高亮/跳动直接写入内容
    // 从“重建后”的 markers 中收集命中项（旧引用已离图，必须用新引用）
    var matchedMarkers = Object.keys(state.searchMatches)
      .map(function(u){ return state.markers[u]; })
      .filter(Boolean);
    if(matchedMarkers.length){
      state.amap.setFitView(matchedMarkers, false, [80,80,80,80]);
    }
    var c = $("map-count");
    if(c) c.textContent = "命中并高亮 "+matchedMarkers.length+" 个（跳动中）";
  }
  /* ---------------- 地图手动选点（在主地图操作，不嵌套弹窗） ---------------- */
  function enterPickMode(){
    if(!state.amapReady){ toast("请先配置高德地图密钥", "warn"); return; }
    state.pickMode = true;
    state.pickTarget = null;
    var el = $("amap-container"); if(el) el.classList.add("pick-on");
    showMapHint("手动选点模式：请先在地图上点击要更新的「单位标记」（蓝色圆点），选中后再点击地图任意位置设置新地址（按 Esc 取消）");
  }
  function exitPickMode(){
    state.pickMode = false;
    state.pickTarget = null;
    var el = $("amap-container"); if(el) el.classList.remove("pick-on");
    hideMapHint();
  }
  function pickMarkerChosen(uid){
    var rec = state.data.find(function(r){ return r._uid === uid; });
    if(!rec) return;
    state.pickTarget = uid;
    showMapHint("已选择「"+rec.name+"」：请在地图上点击任意位置以更新其地址与坐标（Esc 取消）");
  }
  function onMapClick(e){
    if(!state.pickMode) return;
    if(!state.pickTarget) return;   // 需先点选单位标记
    var lng = e.lnglat.getLng(), lat = e.lnglat.getLat();
    var rec = state.data.find(function(r){ return r._uid === state.pickTarget; });
    exitPickMode();
    if(rec){ reverseGeocode(lng, lat, rec); }
  }
  function showMapHint(msg){
    var h = $("map-hint");
    if(h){ h.textContent = msg; h.style.display = "block"; }
  }
  function hideMapHint(){
    var h = $("map-hint");
    if(h){ h.style.display = "none"; }
  }
  var searchTimer = null;
  function onSearchInput(){
    var q = $("map-search").value.trim();
    if(searchTimer) clearTimeout(searchTimer);
    searchTimer = setTimeout(function(){ renderSuggest(q); }, 200);
  }
  // 边输入边弹出候选项
  function renderSuggest(q){
    var box = $("map-suggest");
    if(!box) return;
    q = q.trim().toLowerCase();
    if(!q){ box.style.display = "none"; box.innerHTML = ""; return; }
    var matches = state.data.filter(function(r){
      return (r.name + r.address + r.license).toLowerCase().indexOf(q) >= 0;
    }).slice(0, 10);
    if(!matches.length){ box.style.display = "none"; box.innerHTML = ""; return; }
    box.innerHTML = matches.map(function(r){
      return '<div class="suggest-item" data-uid="'+r._uid+'">'+
        '<div class="si-name">'+esc(r.name)+'</div>'+
        '<div class="si-sub">'+esc(r.license)+' ｜ '+esc(r.address)+'</div>'+
      '</div>';
    }).join("");
    box.style.display = "block";
  }
  function geocodeOne(rec){
    return new Promise(function(resolve){
      if(!state.geocoder || !rec.address){ resolve(null); return; }
      var done = false;
      // 超时保护：若高德回调未触发（限流/网络抖动），避免整批卡死
      var timer = setTimeout(function(){ if(!done){ done = true; resolve(null); } }, 5000);
      state.geocoder.getLocation(rec.address, function(status, result){
        if(done) return;
        done = true; clearTimeout(timer);
        if(status === "complete" && result.geocodes && result.geocodes.length){
          var loc = result.geocodes[0].location;
          resolve({ lng:loc.lng, lat:loc.lat });
        } else {
          resolve(null);
        }
      });
    });
  }
  // 批量地理编码：放慢节奏避免限流，失败重试退避；逐条成功即落盘；可回调进度
  async function geocodeMany(list, onProgress){
    if(!state.amapReady){ return; }
    var stepDelay = 350;   // ~3 QPS，远低于免费密钥限流阈值
    var done = 0, okCount = 0;
    for(var i=0;i<list.length;i++){
      var rec = list[i];
      if(!rec.address) continue;
      if(rec.lng!=null && rec.lat!=null) continue;
      var ok = false;
      for(var attempt=0; attempt<3 && !ok; attempt++){
        var g = await geocodeOne(rec);
        if(g){ rec.lng = g.lng; rec.lat = g.lat; ok = true; }
        else { await sleep(600 * (attempt + 1)); } // 退避重试
      }
      done++; if(ok) okCount++;
      saveDataLocal();                 // 每成功一条立即持久化，绝不丢失已编码结果
      if(onProgress) onProgress(done, list.length, ok);
      await sleep(stepDelay);
    }
    saveDataLocal();
    return okCount;
  }
  var geoRunning = false;
  function geocodeMissing(){
    if(!state.amapReady){ toast("请先配置高德地图密钥", "warn"); return; }
    if(geoRunning) return;
    var missing = state.data.filter(function(r){ return (r.lng==null || r.lat==null) && r.address; });
    if(!missing.length){ toast("全部记录已有坐标", "ok"); return; }
    geoRunning = true;
    toast("正在地理编码 " + missing.length + " 条地址…", "ok");
    geocodeMany(missing, function(done, total, ok){
      if(state.view === "map") placeMarkers();   // 边编码边在地图上打点
    }).then(function(okCount){
      geoRunning = false;
      if(state.view === "map") placeMarkers();
      toast("地理编码完成：成功 " + okCount + " / " + missing.length + " 条", "ok");
    });
  }
  function reverseGeocode(lng, lat, rec){
    if(!state.geocoder){ rec.lng=lng; rec.lat=lat; saveData(); refreshIfMap(); return; }
    state.geocoder.getAddress([lng, lat], function(status, result){
      var addr = "";
      if(status === "complete" && result.regeocode){
        addr = result.regeocode.formattedAddress;
      }
      rec.address = addr;
      rec.lng = lng; rec.lat = lat;
      var dAddr = $("detail-address");
      if(dAddr) dAddr.textContent = addr || (lng.toFixed(6)+", "+lat.toFixed(6));
      saveData();
      refreshIfMap();
      toast("已更新地址与坐标：" + (addr || (lng.toFixed(6)+", "+lat.toFixed(6))), "ok");
    });
  }

  /* ---------------- Toast ---------------- */
  function toast(msg, type){
    var wrap = $("toast-wrap");
    var t = document.createElement("div");
    t.className = "toast" + (type ? " "+type : "");
    t.textContent = msg;
    wrap.appendChild(t);
    requestAnimationFrame(function(){ t.classList.add("show"); });
    setTimeout(function(){ t.classList.remove("show"); setTimeout(function(){ t.remove(); }, 300); }, 2600);
  }

  /* ---------------- 弹窗 ---------------- */
  function closeModal(){
    var o = $("modal-overlay");
    if(o) o.remove();
  }
  function showModal(html){
    closeModal();
    var overlay = document.createElement("div");
    overlay.className = "modal-overlay";
    overlay.id = "modal-overlay";
    overlay.innerHTML = '<div class="modal">' + html + '</div>';
    document.body.appendChild(overlay);
    overlay.addEventListener("click", function(e){
      if(e.target === overlay) closeModal();
    });
    return overlay;
  }

  /* ---------------- 单位详情弹窗（全局统一） ---------------- */
  function openDetail(u){
    var rec = state.data.find(function(r){ return r._uid === u; });
    if(!rec) return;
    var du = daysUntil(rec.validTo);
    var duHtml = du==null ? '<span class="pill gray">无日期</span>'
      : (du < 0 ? '<span class="pill red">已逾期 '+Math.abs(du)+' 天</span>'
      : (du <= 30 ? '<span class="pill amber">剩 '+du+' 天</span>' : '<span class="pill green">剩 '+du+' 天</span>'));
    var html =
      '<div class="modal-head"><h3>单位详情</h3><button class="x" onclick="window.__wb.closeModal()">×</button></div>' +
      '<div class="modal-body">' +
        '<div class="kv"><span>编号</span><b>'+esc(rec.id)+'</b></div>' +
        '<div class="kv"><span>单位名称</span><b>'+esc(rec.name)+'</b></div>' +
        '<div class="kv"><span>经营地址</span><b id="detail-address">'+esc(rec.address)+'</b></div>' +
        '<div class="kv"><span>卫生许可证号</span><b>'+esc(rec.license)+'</b></div>' +
        '<div class="kv"><span>有效期始</span><b>'+esc(rec.validFrom)+'</b></div>' +
        '<div class="kv"><span>有效期止</span><b>'+esc(rec.validTo)+' '+duHtml+'</b></div>' +
        '<div class="kv"><span>坐标</span><b>'+esc(coordText(rec))+'</b></div>' +
        '<div class="kv"><span>备注</span><b class="remark-text">'+esc(rec.remark||"")+'</b></div>' +
        '<div class="actions">' +
          '<button class="btn primary" id="detail-edit">编辑</button>' +
        '</div>' +
      '</div>';
    showModal(html);
    $("detail-edit").onclick = function(){ openEdit(rec._uid); };
  }

  /* ---------------- 编辑弹窗（可修改全部字段） ---------------- */
  function openEdit(u){
    var rec = state.data.find(function(r){ return r._uid === u; });
    if(!rec) return;
    var html =
      '<div class="modal-head"><h3>编辑单位</h3><button class="x" onclick="window.__wb.closeModal()">×</button></div>' +
      '<div class="modal-body">' +
        '<div class="editgrid">' +
          '<label class="fld">编号<input type="text" id="e-id" value="'+esc(rec.id)+'"></label>' +
          '<label class="fld">单位名称<input type="text" id="e-name" value="'+esc(rec.name)+'"></label>' +
          '<label class="fld">经营地址<input type="text" id="e-address" value="'+esc(rec.address)+'"></label>' +
          '<label class="fld">卫生许可证号<input type="text" id="e-license" value="'+esc(rec.license)+'"></label>' +
          '<label class="fld">有效期始<input type="date" id="e-from" value="'+esc(rec.validFrom)+'"></label>' +
          '<label class="fld">有效期止<input type="date" id="e-to" value="'+esc(rec.validTo)+'"></label>' +
        '</div>' +
        '<label class="fld" style="margin-top:12px"><span>备注</span>' +
          '<textarea id="e-remark" rows="3" style="width:100%;resize:vertical;font:inherit;padding:8px 10px;border:1px solid var(--line);border-radius:9px">'+esc(rec.remark||"")+'</textarea>' +
        '</label>' +
        '<div class="actions">' +
          '<button class="btn" onclick="window.__wb.closeModal()">取消</button>' +
          '<button class="btn primary" id="e-save">保存</button>' +
        '</div>' +
      '</div>';
    showModal(html);
    $("e-save").onclick = function(){
      var newAddr = $("e-address").value.trim();
      rec.id = $("e-id").value.trim();
      rec.name = $("e-name").value.trim();
      rec.address = newAddr;
      rec.license = $("e-license").value.trim();
      rec.validFrom = $("e-from").value;
      rec.validTo = $("e-to").value;
      rec.remark = $("e-remark").value;
      saveData();
      refreshIfMap();
      renderCurrentView();
      closeModal();
      toast("已保存修改", "ok");
    };
  }

  /* ---------------- 首页：到期提醒 + 办结 ---------------- */
  function renderHome(){
    var win = state.homeWindow;
    var list = state.data.map(function(r){ return { r:r, days:daysUntil(r.validTo) }; })
      .filter(function(x){ return x.days !== null; });
    var overdue = list.filter(function(x){ return x.days < 0; }).sort(function(a,b){ return a.days - b.days; });
    var upcoming = list.filter(function(x){
      if(win === "all") return x.days >= 0;
      return x.days >= 0 && x.days <= Number(win);
    }).sort(function(a,b){ return a.days - b.days; });

    function card(x){
      var r = x.r;
      var pill = x.days < 0 ? '<span class="pill red">已逾期 '+Math.abs(x.days)+' 天</span>'
        : (x.days <= 30 ? '<span class="pill amber">剩 '+x.days+' 天</span>' : '<span class="pill green">剩 '+x.days+' 天</span>');
      return '<div class="reminder" data-action="detail" data-uid="'+r._uid+'">' +
        '<div class="main">' +
          '<div class="nm">'+esc(r.name)+'</div>' +
          '<div class="sub">'+esc(r.address)+' ｜ '+esc(r.license)+' ｜ 有效期止 '+esc(r.validTo)+'</div>' +
        '</div>' +
        '<div class="right">'+pill+
          '<button class="btn primary sm" data-action="banjie" data-uid="'+r._uid+'">办结</button>' +
        '</div>' +
      '</div>';
    }
    var html = "";
    if(overdue.length){
      html += '<div class="grp-title">⚠️ 已过期（'+overdue.length+'）</div>';
      html += overdue.map(card).join("");
    }
    html += '<div class="grp-title">'+(win==="all"?"即将到期":"未来 "+win+" 天内即将到期")+'（'+upcoming.length+'）</div>';
    if(upcoming.length){
      html += upcoming.map(card).join("");
    } else {
      html += '<div class="empty">该时间范围内没有即将到期的单位 🎉</div>';
    }
    $("home-list").innerHTML = html;
  }

  function doBanjie(u){
    var rec = state.data.find(function(r){ return r._uid === u; });
    if(!rec) return;
    var today = iso(new Date());
    var html =
      '<div class="modal-head"><h3>办结 — '+esc(rec.name)+'</h3><button class="x" onclick="window.__wb.closeModal()">×</button></div>' +
      '<div class="modal-body">' +
        '<label class="fld">选择新的「有效期始」日期<input type="date" id="bj-date" value="'+today+'"></label>' +
        '<p class="hint" style="margin-top:12px">系统将自动计算：<b>有效期止 = 所选日期 + 4 年 - 1 天</b></p>' +
        '<div class="kv" style="margin-top:8px"><span>将更新为</span><b id="bj-preview">—</b></div>' +
        '<div class="actions">' +
          '<button class="btn" onclick="window.__wb.closeModal()">取消</button>' +
          '<button class="btn primary" id="bj-save">确认办结</button>' +
        '</div>' +
      '</div>';
    showModal(html);
    function preview(){
      var d = $("bj-date").value;
      $("bj-preview").textContent = d ? (d + "  ~  " + calcValidTo(d)) : "—";
    }
    $("bj-date").addEventListener("change", preview);
    preview();
    $("bj-save").onclick = function(){
      var d = $("bj-date").value;
      if(!d){ toast("请选择日期", "warn"); return; }
      rec.validFrom = d;
      rec.validTo = calcValidTo(d);
      saveData();
      renderCurrentView();
      closeModal();
      toast("已办结：" + rec.name + " 有效期更新至 " + rec.validTo, "ok");
    };
  }

  /* ---------------- 台账 ---------------- */
  function renderLedger(){
    var body = $("ledger-body");
    var q = (state.ledgerQuery||"").trim().toLowerCase();
    var rows = state.data;
    if(q){
      rows = rows.filter(function(r){
        return (r.id+" "+r.name+" "+r.address+" "+r.license).toLowerCase().indexOf(q) >= 0;
      });
    }
    if(!rows.length){
      body.innerHTML = '<tr><td colspan="8" class="empty">'+(q?"没有匹配「"+esc(state.ledgerQuery)+"」的单位":"暂无数据，请在上方手动新增或导入。")+'</td></tr>';
    } else {
      body.innerHTML = rows.map(function(r){
        return '<tr data-action="detail" data-uid="'+r._uid+'">' +
          '<td><input type="checkbox" class="rowsel row-select" data-uid="'+r._uid+'" '+(state.selected[r._uid]?"checked":"")+'></td>' +
          '<td>'+esc(r.id)+'</td>' +
          '<td>'+esc(r.name)+'</td>' +
          '<td class="addr">'+esc(r.address)+'</td>' +
          '<td class="addr remark-cell" title="'+esc(r.remark||"")+'">'+esc(r.remark||"")+'</td>' +
          '<td>'+esc(r.license)+'</td>' +
          '<td>'+esc(r.validFrom)+'</td>' +
          '<td>'+esc(r.validTo)+'</td>' +
          '<td>'+esc(coordText(r))+'</td>' +
        '</tr>';
      }).join("");
    }
    updateStat();
    updateLedgerHint();
  }
  function updateLedgerHint(){
    var n = Object.keys(state.selected).filter(function(k){ return state.selected[k]; }).length;
    $("ledger-hint").textContent = n ? ("已选中 "+n+" 条，可批量删除") : "";
  }

  function addManual(){
    var name = $("add-name").value.trim();
    var license = $("add-license").value.trim();
    if(!name){ toast("请填写单位名称", "warn"); return; }
    var exist = state.data.find(function(r){ return r.license === license; });
    if(exist){ toast("该卫生许可证号已存在，请使用导入以覆盖更新", "warn"); return; }
    var rec = {
      _uid: uid(),
      id: $("add-id").value.trim() || nextId(),
      name: name,
      address: $("add-address").value.trim(),
      license: license,
      validFrom: $("add-from").value,
      validTo: $("add-to").value,
      remark: $("add-remark") ? $("add-remark").value.trim() : "",
      lng: null, lat: null
    };
    state.data.push(rec);
    saveData(false);
    ensureAmap().then(function(){ return geocodeMany([rec]); }).then(function(){
      saveData(); renderLedger(); if(state.view==="map") placeMarkers();
    });
    clearAddForm();
    renderLedger();
    toast("已添加单位：" + name, "ok");
  }
  function clearAddForm(){
    ["add-id","add-name","add-address","add-license","add-from","add-to"].forEach(function(id){ $(id).value=""; });
  }

  function importExcel(file){
    if(!window.XLSX){ toast("表格解析库未加载，请检查网络后重试", "err"); return; }
    var reader = new FileReader();
    reader.onload = function(e){
      try{
        var wb = window.XLSX.read(e.target.result, { type:"array" });
        var ws = wb.Sheets[wb.SheetNames[0]];
        var rows = window.XLSX.utils.sheet_to_json(ws, { defval:"" });
        var added = 0, updated = 0, toGeocode = [];
        rows.forEach(function(row){
          var lic = String(row["卫生许可证号"]||"").trim();
          if(!lic) return;
          var name = String(row["单位名称"]||row["单位"]||"").trim();
          var address = String(row["经营地址"]||"").trim();
          var vf = normExcelDate(row["有效期始"]);
          var vt = normExcelDate(row["有效期止"]);
          var id = String(row["编号"]||"").trim();
          var remark = String(row["备注"]||"").trim();
          var exist = state.data.find(function(r){ return r.license === lic; });
          if(exist){
            // 存在相同许可证号 → 仅覆盖更新有效期始/止
            if(vf) exist.validFrom = vf;
            if(vt) exist.validTo = vt;
            if(remark) exist.remark = remark;
            updated++;
            if(exist.address && (exist.lng==null || exist.lat==null)) toGeocode.push(exist);
          } else {
            var rec = {
              _uid: uid(),
              id: id || nextId(),
              name: name,
              address: address,
              license: lic,
              validFrom: vf,
              validTo: vt,
              remark: remark,
              lng: null, lat: null
            };
            state.data.push(rec);
            added++;
            if(address) toGeocode.push(rec);
          }
        });
        saveData(false);
        ensureAmap().then(function(){ return geocodeMany(toGeocode); }).then(function(){
          saveData(); renderLedger(); if(state.view==="map") placeMarkers();
        });
        renderLedger();
        toast("导入完成：新增 "+added+" 条，覆盖更新 "+updated+" 条", "ok");
      }catch(err){
        toast("导入失败：" + (err.message||err), "err");
      }
    };
    reader.readAsArrayBuffer(file);
  }

  function batchDelete(){
    var keys = Object.keys(state.selected).filter(function(k){ return state.selected[k]; });
    if(!keys.length){ toast("请先勾选要删除的记录", "warn"); return; }
    if(!confirm("确定删除选中的 "+keys.length+" 条记录？此操作不可撤销。")) return;
    // 先收集要删除记录的许可证号，用于同步删除云端（否则云端残留会在刷新时被自动拉取复活）
    var delLicenses = state.data.filter(function(r){ return state.selected[r._uid]; })
                        .map(function(r){ return r.license; }).filter(Boolean);
    state.data = state.data.filter(function(r){ return !state.selected[r._uid]; });
    keys.forEach(function(k){ delete state.selected[k]; });
    saveData();
    deleteCloud(delLicenses, true);
    renderLedger();
    if(state.view==="map") placeMarkers();
    toast("已删除 "+keys.length+" 条", "ok");
  }

  function exportJson(){
    var blob = new Blob([JSON.stringify(state.data, null, 2)], { type:"application/json" });
    var a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "卫生许可台账_导出.json";
    a.click();
    URL.revokeObjectURL(a.href);
  }

  /* ---------------- 地图渲染 ---------------- */
  function renderMapView(){
    var box = $("map-note-box");
    if(!state.settings.amapKey){
      box.innerHTML = '<div class="map-note" style="margin-bottom:12px">尚未配置高德地图密钥。请前往「设置界面」填写 Key 与安全密钥后，地图与自动地理编码即可生效。</div>';
      return;
    }
    box.innerHTML = "";
    ensureAmap().then(function(ok){
      if(ok){
        initMap();
        // 坐标已持久化（localStorage + Supabase），打开地图不再重新编码；
        // 仅提示尚未编码的地址，由用户点「地理编码全部」或手动选点来完成。
        var missing = state.data.filter(function(r){ return (r.lng==null || r.lat==null) && r.address; });
        if(missing.length){
          box.innerHTML = '<div class="map-note" style="margin-bottom:12px">已编码的坐标已记住、不会重复编码。当前还有 '+missing.length+' 条地址未编码，点上方「🔄 地理编码全部」即可生成地图点位（手动地图上选点也会自动记录坐标）。</div>';
        } else {
          box.innerHTML = "";
        }
      } else {
        box.innerHTML = '<div class="map-note" style="margin-bottom:12px">高德地图加载失败，请检查密钥与网络。</div>';
      }
    });
  }

  function refreshIfMap(){ if(state.view === "map" && state.amap) placeMarkers(); }

  /* ---------------- 设置 ---------------- */
  function fillSettings(){
    $("set-amap-key").value = state.settings.amapKey || "";
    $("set-amap-sec").value = state.settings.amapSecurity || "";
    $("set-sb-url").value = state.settings.supabaseUrl || "";
    $("set-sb-key").value = state.settings.supabaseKey || "";
    $("set-sb-table").value = state.settings.supabaseTable || "units";
  }
  function saveSettings(){
    var prevAmap = state.settings.amapKey + "|" + state.settings.amapSecurity;
    state.settings.amapKey = $("set-amap-key").value.trim();
    state.settings.amapSecurity = $("set-amap-sec").value.trim();
    state.settings.supabaseUrl = $("set-sb-url").value.trim();
    state.settings.supabaseKey = $("set-sb-key").value.trim();
    state.settings.supabaseTable = $("set-sb-table").value.trim() || "units";
    saveSettingsLocal();
    var nowAmap = state.settings.amapKey + "|" + state.settings.amapSecurity;
    $("set-status").textContent = "设置已保存。";
    toast("设置已保存", "ok");
    if(nowAmap !== prevAmap){
      toast("地图密钥已变更，即将重新加载以生效…");
      setTimeout(function(){ location.reload(); }, 900);
    }
  }

  /* ---------------- 视图切换 ---------------- */
  function switchView(v){
    if(v !== "map" && state.pickMode) exitPickMode();   // 离开地图视图时退出选点模式
    state.view = v;
    document.querySelectorAll(".view").forEach(function(s){ s.classList.remove("active"); });
    $("view-"+v).classList.add("active");
    document.querySelectorAll("#tabs button").forEach(function(b){
      b.classList.toggle("active", b.getAttribute("data-view") === v);
    });
    if(v === "home") renderHome();
    else if(v === "ledger") renderLedger();
    else if(v === "map") renderMapView();
    else if(v === "settings") fillSettings();
  }
  function renderCurrentView(){ switchView(state.view); }

  function updateStat(){
    var cnt = $("stat");
    if(cnt) cnt.textContent = "共 " + state.data.length + " 条";
  }

  /* ---------------- 事件绑定 ---------------- */
  function bind(){
    $("tabs").addEventListener("click", function(e){
      var b = e.target.closest("button[data-view]");
      if(b) switchView(b.getAttribute("data-view"));
    });

    // 首页列表（事件委托）
    $("home-list").addEventListener("click", function(e){
      var el = e.target.closest("[data-action]");
      if(!el) return;
      var u = el.getAttribute("data-uid");
      var act = el.getAttribute("data-action");
      if(act === "banjie") doBanjie(u);
      else if(act === "detail") openDetail(u);
    });
    $("home-filter").addEventListener("change", function(){
      state.homeWindow = this.value === "all" ? "all" : Number(this.value);
      renderHome();
    });

    // 台账
    $("ledger-body").addEventListener("click", function(e){
      if(e.target.classList.contains("row-select")) return; // 复选框单独处理
      var el = e.target.closest("[data-action]");
      if(el && el.getAttribute("data-action") === "detail") openDetail(el.getAttribute("data-uid"));
    });
    $("ledger-body").addEventListener("change", function(e){
      if(e.target.classList.contains("row-select")){
        var u = e.target.getAttribute("data-uid");
        state.selected[u] = e.target.checked;
        updateLedgerHint();
      }
    });
    $("select-all").addEventListener("change", function(){
      var checked = this.checked;
      state.data.forEach(function(r){ state.selected[r._uid] = checked; });
      document.querySelectorAll(".row-select").forEach(function(c){ c.checked = checked; });
      updateLedgerHint();
    });
    $("add-submit").addEventListener("click", addManual);
    $("add-clear").addEventListener("click", clearAddForm);
    $("import-btn").addEventListener("click", function(){ $("import-file").click(); });
    $("import-file").addEventListener("change", function(){
      if(this.files && this.files[0]) importExcel(this.files[0]);
      this.value = "";
    });
    $("batch-delete").addEventListener("click", batchDelete);
    $("export-btn").addEventListener("click", exportJson);
    // 台账搜索
    $("ledger-search").addEventListener("input", function(){
      state.ledgerQuery = this.value;
      renderLedger();
    });

    // 地图搜索：边输入边出候选项；回车执行高亮跳动
    $("map-search").addEventListener("input", onSearchInput);
    $("map-search").addEventListener("keydown", function(e){
      if(e.key === "Enter"){ state.mapQuery = this.value; performSearch(this.value); }
    });
    $("map-suggest").addEventListener("click", function(e){
      var it = e.target.closest(".suggest-item"); if(!it) return;
      var u = it.getAttribute("data-uid");
      var rec = state.data.find(function(r){ return r._uid === u; });
      if(!rec) return;
      $("map-search").value = rec.name;
      state.mapQuery = rec.name;
      performSearch(rec.name);
      if(rec.lng != null && state.amap) state.amap.setCenter([rec.lng, rec.lat]);
    });
    // 点击空白处收起候选项
    document.addEventListener("click", function(e){
      var s = $("map-suggest"); if(!s) return;
      if(!e.target.closest(".search-wrap")){ s.style.display = "none"; s.innerHTML = ""; }
    });
    $("geo-all").addEventListener("click", geocodeMissing);
    $("map-pick").addEventListener("click", function(){
      // 若已在选点模式则再次点击退出，否则进入
      if(state.pickMode) exitPickMode();
      else enterPickMode();
    });

    // 设置
    $("set-save").addEventListener("click", saveSettings);
    $("sb-push").addEventListener("click", function(){ pushCloud(false); });
    $("sb-pull").addEventListener("click", function(){
      if(!confirm("从云端拉取将用云端数据覆盖本地全部记录，确定继续？")) return;
      pullCloud();
    });

    // Supabase 库加载（CDN）
    var autoPulled = false;
    var sb = document.createElement("script");
    sb.src = "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2";
    sb.onload = function(){
      // Supabase 就绪后，自动从云端合并一次：打开页面即与云端同步，无需手动拉取
      if(!autoPulled && state.settings.supabaseUrl && state.settings.supabaseKey){
        autoPulled = true;
        pullCloud({ confirm:false, merge:true, quietError:true });
      }
    };
    document.head.appendChild(sb);
    // SheetJS 库加载（CDN）
    var xls = document.createElement("script");
    xls.src = "https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js";
    document.head.appendChild(xls);
  }

  /* ---------------- 启动 ---------------- */
  window.__wb = { closeModal: closeModal, openDetail: openDetail, enterPickMode: enterPickMode, exitPickMode: exitPickMode };

  // Esc 取消地图手动选点
  document.addEventListener("keydown", function(e){
    if(e.key === "Escape" && state.pickMode) exitPickMode();
  });
  function init(){
    loadSettings();
    loadData();
    bind();
    updateStat();
    switchView("home");
  }
  if(document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
