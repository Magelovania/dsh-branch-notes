/**
 * 枝条笔记 · 客户端半（浏览器 bundle）
 *
 * 格式：Harness 的 __ModuleLoader__ 工厂（与 dsh-whale-pet-plugin 同款，零构建）。
 * 职责：
 *   - 在左侧栏（sidebar.panellist）加一个「枝条笔记」图标；
 *   - 在中央面板（main，key 与图标 id 同名）里用 iframe 载入宿主提供的 /app 页面；
 *   - 一切数据与 AI 调用都在宿主半（lib/core.mjs）完成，本文件不碰凭据。
 */
window.__ModuleLoader__.load({
  id: 'dsh-branch-notes',
  factory: function (require) {
    var module = { exports: {} };
    var exports = module.exports;

    var VERSION = '0.2.0';
    var BASE = '/api/dsh-branch-notes';
    var PANEL_ID = 'branch-notes';
    var LABEL = '枝条笔记';
    // 每次挂载都换一个 query，避免 WebView 缓存住旧页面（开发期改 app.html 立刻可见）
    function appUrl() {
      return BASE + '/app?v=' + Date.now();
    }

    var React = null;
    try {
      React = require('react');
    } catch (error) {
      React = null;
    }

    /** 取客户端服务：注入声明之外的属性访问会抛错，退回 ctx.get(key)。 */
    function getService(ctx, key) {
      try {
        var value = ctx[key];
        if (value) return value;
      } catch (error) {
        /* 未注入，继续尝试 ctx.get */
      }
      try {
        return typeof ctx.get === 'function' ? ctx.get(key) : null;
      } catch (error) {
        return null;
      }
    }

    /* ------------------------------------------------------------ 上报（自检用） */
    function send(payload) {
      try {
        fetch(BASE + '/log', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
          keepalive: true,
        }).catch(function () {});
      } catch (error) {
        /* 日志失败不影响主流程 */
      }
    }

    /** 自检：确认页面所在的 dsh-app:// 协议能否把 /api/* 转发到宿主。 */
    function probeNetwork() {
      var out = {
        type: 'probe-network',
        href: typeof location !== 'undefined' ? location.href : '',
        origin: typeof location !== 'undefined' ? location.origin : '',
        protocol: typeof location !== 'undefined' ? location.protocol : '',
      };
      try {
        out.bootKeys = Object.keys(window.__DSH_BOOT__ || {});
      } catch (error) {
        out.bootKeys = 'ERR';
      }
      fetch(BASE + '/ping', { cache: 'no-store' })
        .then(function (res) { return res.text(); })
        .then(function (text) { out.ping = text.slice(0, 120); return fetch(BASE + '/app', { cache: 'no-store' }); })
        .then(function (res) {
          out.appStatus = res.status;
          out.appType = res.headers.get('content-type');
          return res.text();
        })
        .then(function (text) {
          out.appLen = text.length;
          send(out);
        })
        .catch(function (error) {
          out.error = String((error && error.message) || error);
          send(out);
        });
    }

    if (typeof window !== 'undefined') {
      window.addEventListener('error', function (event) {
        send({ type: 'window-error', message: String(event.message || ''), source: String(event.filename || ''), line: event.lineno });
      });
      window.addEventListener('unhandledrejection', function (event) {
        send({ type: 'unhandled-rejection', message: String((event.reason && event.reason.message) || event.reason) });
      });
    }

    /* ------------------------------------------------------------------ 图标 */
    function iconMarkup(size, active) {
      var s = size || 18;
      var opacity = active ? '1' : '.78';
      return (
        '<svg width="' + s + '" height="' + s + '" viewBox="0 0 24 24" fill="none" ' +
        'xmlns="http://www.w3.org/2000/svg" style="display:block;opacity:' + opacity + '">' +
        '<path d="M5 4v9.5A4.5 4.5 0 0 0 9.5 18H19" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>' +
        '<path d="M9.5 18V9" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>' +
        '<path d="M9.5 9h6.5" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>' +
        '<circle cx="5" cy="3.6" r="1.5" fill="currentColor"/>' +
        '<circle cx="19" cy="18" r="1.7" fill="currentColor"/>' +
        '<circle cx="16.4" cy="9" r="1.5" fill="currentColor"/>' +
        '</svg>'
      );
    }

    function iconNode(size, active) {
      var span = document.createElement('span');
      span.style.cssText = 'display:flex;align-items:center;justify-content:center;color:inherit';
      span.innerHTML = iconMarkup(size, active);
      return span;
    }

    function BranchNotesIcon(props) {
      var size = (props && props.size) || 18;
      var active = !!(props && props.active);
      if (React && React.createElement) {
        return React.createElement('span', {
          style: { display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'inherit' },
          dangerouslySetInnerHTML: { __html: iconMarkup(size, active) },
        });
      }
      return iconNode(size, active);
    }

    /* ------------------------------------------------------------------ 面板 */
    function panelNode() {
      var wrap = document.createElement('div');
      wrap.style.cssText = 'position:relative;display:flex;flex-direction:column;flex:1 1 auto;min-height:0;width:100%;height:100%;background:#F6F2EC';
      var frame = document.createElement('iframe');
      frame.src = appUrl();
      frame.title = LABEL;
      frame.setAttribute('data-bn-frame', '1');
      frame.setAttribute('allow', 'clipboard-write');
      frame.style.cssText = 'border:0;display:block;width:100%;height:100%;flex:1 1 auto;background:#F6F2EC';
      frame.addEventListener('load', function () {
        send({ type: 'iframe-load', src: appUrl() });
      });
      wrap.appendChild(frame);
      return wrap;
    }

    function BranchNotesPanel() {
      if (React && React.createElement) {
        return React.createElement(
          'div',
          {
            style: {
              position: 'relative',
              display: 'flex',
              flexDirection: 'column',
              flex: '1 1 auto',
              minHeight: 0,
              width: '100%',
              height: '100%',
              background: '#F6F2EC',
            },
          },
          React.createElement('iframe', {
            src: appUrl(),
            title: LABEL,
            allow: 'clipboard-write',
            'data-bn-frame': '1',
            style: { border: 0, display: 'block', width: '100%', height: '100%', flex: '1 1 auto', background: '#F6F2EC' },
            onLoad: function () {
              send({ type: 'iframe-load', src: appUrl() });
            },
          }),
        );
      }
      return panelNode();
    }

    /* ------------------------------------------------------------------ 注册 */
    function describeEntries(slots, name) {
      try {
        var entries = typeof slots.entries === 'function' ? slots.entries(name) : null;
        if (!entries) return null;
        var out = [];
        (entries.forEach ? entries : []).forEach(function (entry) {
          out.push({ id: entry && entry.options ? entry.options.id : null, key: entry && entry.options ? entry.options.key : null });
        });
        return out;
      } catch (error) {
        return 'probe-failed: ' + String((error && error.message) || error);
      }
    }

    function apply(ctx) {
      var slots = ctx && ctx.slots;
      if (!slots && ctx && typeof ctx.get === 'function') {
        try {
          slots = ctx.get('slots');
        } catch (error) {
          slots = undefined;
        }
      }
      send({
        type: 'client-apply',
        hasSlots: !!slots,
        hasReact: !!React,
        href: typeof location !== 'undefined' ? location.href : '',
      });
      probeNetwork();
      var layout = getService(ctx, 'layout');
      window.__dshBranchNotesSelectPanel = function () {
        try {
          layout.selectPanel(PANEL_ID);
          send({ type: 'select-panel', panelId: PANEL_ID });
        } catch (error) {
          send({ type: 'select-panel-error', message: String((error && error.message) || error) });
        }
      };
      /* -------------------------------------------------
       * 「在对话里直接打开面板」：轮询宿主命令队列
       * 工具 branch_notes_open（宿主 core.mjs）写入 commands.json，
       * 这里每 2 秒拉一次 GET /commands，发现 openRequest 变新就切过去。
       * ----------------------------------------------- */
      var SEEN_KEY = 'coc-notes:cmdSeen';
      var seenOpen = 0;
      try {
        seenOpen = Number(localStorage.getItem(SEEN_KEY) || 0) || 0;
      } catch (error) {
        seenOpen = 0;
      }
      function gotoFrame(note) {
        var frame = document.querySelector('iframe[data-bn-frame]');
        if (!frame) return;
        frame.src = appUrl() + '&goto=' + encodeURIComponent(note);
      }
      function openFromCommand(note, reload) {
        try {
          layout.selectPanel(PANEL_ID);
        } catch (error) {
          /* 布局服务不可用时不阻断 */
        }
        send({ type: 'open-requested', note: note || '', reload: !!reload });
        if (note) setTimeout(function () { gotoFrame(note); }, 480);
        else if (reload) setTimeout(function () {
          var frame = document.querySelector('iframe[data-bn-frame]');
          if (frame) frame.src = appUrl();
        }, 480);
      }
      window.__dshBranchNotesOpen = openFromCommand;
      function pollCommands() {
        fetch(BASE + '/commands', { cache: 'no-store' })
          .then(function (res) { return res.json(); })
          .then(function (data) {
            var ts = Number((data && data.openRequest) || 0);
            if (!ts || ts <= seenOpen) return;
            seenOpen = ts;
            try { localStorage.setItem(SEEN_KEY, String(ts)); } catch (error) { /* 忽略 */ }
            openFromCommand((data && data.note) || '', !!(data && data.reload));
          })
          .catch(function () {});
      }
      setTimeout(pollCommands, 1000);
      setInterval(pollCommands, 2000);

      if (!slots || typeof slots.inject !== 'function' || typeof slots.register !== 'function') return;
      try {
        slots.inject('sidebar.panellist', function () {
          return slots.register(
            { name: 'sidebar.panellist', id: PANEL_ID, order: 30, label: function () { return LABEL; } },
            BranchNotesIcon,
          );
        });
        slots.inject('main', function () {
          return slots.register({ name: 'main', key: PANEL_ID, label: function () { return LABEL; } }, BranchNotesPanel);
        });
        setTimeout(function () {
          send({
            type: 'client-registered',
            panellist: describeEntries(slots, 'sidebar.panellist'),
            main: describeEntries(slots, 'main'),
          });
          // 开发期开关：宿主 ~/.dsh/branch-notes/dev.json 里 autoOpen=true 时自动打开面板
          fetch(BASE + '/dev-flags', { cache: 'no-store' })
            .then(function (res) { return res.json(); })
            .then(function (flags) {
              if (flags && flags.autoOpen) window.__dshBranchNotesSelectPanel();
              if (flags && flags.reloadPanel) {
                // 开发期：先切走再切回，强制 iframe 重新挂载（加载最新 app.html）
                try { layout.selectPanel('conversation'); } catch (error) { /* 没有会话面板时忽略 */ }
                setTimeout(function () { window.__dshBranchNotesSelectPanel(); }, 180);
              }
            })
            .catch(function () {});
        }, 800);
      } catch (error) {
        send({ type: 'client-register-error', message: String((error && error.stack) || error) });
      }
    }

    exports.apply = apply;
    exports.inject = ['slots'];
    return module.exports;
  },
});
