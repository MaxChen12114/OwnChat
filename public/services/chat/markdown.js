(function () {
/**
 * Markdown rendering: the rich path (marked + DOMPurify) with a legacy fallback.
 *
 * Libraries are fetched through {@link MarkdownPorts} on every render rather than cached, matching
 * the old "never capture the reference early" semantics. The normalization of the marked-highlight
 * UMD — which may be a function or an exports object carrying `.markedHighlight` — happens in
 * tooling/l0/wiring/markdown.js, so this module only receives an already-normalized highlight factory and
 * treats null as "library missing, fall back to legacy".
 *
 * Red line carried over from the old comment, and the P0 fix of the 2026-11-08 review must stay as
 * it is: the legacy path lifts code blocks and raw tables out first, escapes the remaining text once,
 * and no later branch escapes again; raw tables only let through a whitelist of attribute-free
 * structural tags, and model HTML is never spliced into innerHTML as-is.
 *
 * Equivalence: test/chat-migration-equiv.test.mjs runs the old JS and this product side by side.
 * @module services/chat/markdown
 */

                              
                  
                                      
                                                  
                                         
 

                             
                             
                          
                                                                               
                              
 

                                
                                                               
                                 
 

                           
                                     
                                                                                                     
 

                                   
                     
                                                 
 

                               
                     
                           
                  
                                                                                                       
                                                     
 

                                
                                                                                                    
                              
                                    
                            
 

                                   
                             
                             
                               
 

const ESC_MAP                         = { "&": "&amp;", "<": "&lt;", ">": "&gt;" };

// Implementation mirrors the old markdown.js statement by statement; only window lookups became ports.

function createMarkdown(ports               )                   {
  function renderMarkdownSafe(text        )         {
    if (!text) return "";
    const libs = ports.libs();
    if (libs) {
      try { return renderMarkdownRich(text, libs); }
      catch (e) { console.warn("[md] 富文本渲染失败,回退 legacy 渲染器:", e); }
    }
    return renderMarkdownLegacy(text);
  }

  // Rich path: marked is configured once (extension use / setOptions / the DOMPurify hook run a single
  // time) and the output is wrapped in an .md-body container. The bubble itself is white-space:pre-wrap
  // and marked emits newlines between block tags, so normal collapsing has to be restored or paragraphs
  // gain blank lines. Streaming and plain-text bubbles never come through here and are unaffected.
  function renderMarkdownRich(text        , libs              )         {
    const marked = libs.marked;
    const DP = libs.domPurify;
    if (!marked.__ownchatPatched) {
      const mh = libs.highlight;
      const hl = libs.hljs;
      if (mh && hl) {
        marked.use(mh({
          langPrefix: "hljs language-",
          highlight(code         , lang        ) {
            try {
              const l = (lang && hl.getLanguage(lang)) ? lang : "plaintext";
              return hl.highlight(String(code), { language: l, ignoreIllegals: true }).value;
            } catch (_) {
              return String(code).replace(/[&<>]/g, (c) => ESC_MAP[c] || c);
            }
          },
        }));
      }
      marked.setOptions({ gfm: true, breaks: true, async: false }); // breaks matches the old renderer's \n -> <br>
      DP.addHook("afterSanitizeAttributes", (node             ) => {
        if (node.tagName === "A" && node.hasAttribute("href")) {
          node.setAttribute("target", "_blank");
          node.setAttribute("rel", "noopener noreferrer nofollow");
        } else if (node.tagName === "TABLE") {
          node.classList.add("md-table");
        }
      });
      marked.__ownchatPatched = true;
    }
    const html = DP.sanitize(marked.parse(String(text)));
    return '<div class="md-body">' + html + "</div>";
  }

  // Legacy path, the original implementation from before 2026-09-14: the fallback when the CDN libraries are missing or fail.
  function renderMarkdownLegacy(text        )         {
    if (!text) return "";
    const esc = ports.esc;
    // 1. Lift code blocks out so their insides are never processed
    const blocks           = [];
    let s = text.replace(/```([\w.-]*)\n?([\s\S]*?)```/g, (_, lang        , code        ) => {
      const i = blocks.length;
      const langAttr = lang ? ' class="lang-' + esc(lang) + '"' : "";
      blocks.push("<pre><code" + langAttr + ">" + esc(code.replace(/\n$/, "")) + "</code></pre>");
      return "\x00B" + i + "\x00";
    });
    // 1b. Protect raw <table> HTML the model emitted directly: lift the whole block so the later
    // \n -> <br> pass cannot shred it, then put it back untouched
    s = s.replace(/<table[\s\S]*?<\/table>/gi, (tbl        ) => {
      const _i = blocks.length;
      const _cleaned = tbl.replace(/\*\*+/g, "").replace(/`([^`\n]+)`/g, "<code>$1</code>");
      blocks.push(esc(_cleaned).replace(/&lt;(\/?)(table|thead|tbody|tr|td|th)&gt;/gi, "<$1$2>"));
      return "\x00B" + _i + "\x00";
    });
    // 1c. Escape the remaining text once, before steps 2-7; no later branch escapes again because the content is already safe
    s = esc(s);
    // 2. Tables (GitHub-flavoured)
    s = s.replace(/((?:^|\n)\|.+\|\n\|[-| :]+\|\n(?:\|.+\|\n?)+)/g, (tbl        ) => {
      const rows = tbl.trim().split("\n");
      const parseRow = (r        ) => r.split("|").slice(1, -1).map((c) => c.trim());
      const head = parseRow(rows[0]);
      const body = rows.slice(2).map(parseRow);
      const th = head.map((c) => "<th>" + c + "</th>").join("");
      const tr = body.map((r) => "<tr>" + r.map((c) => "<td>" + c + "</td>").join("") + "</tr>").join("");
      return '<table class="md-table"><thead><tr>' + th + '</tr></thead><tbody>' + tr + '</tbody></table>';
    });
    // 3. Headings
    s = s.replace(/^(#{1,4}) (.+)$/gm, (_, h        , t        ) => '<h' + h.length + ' class="md-h">' + t + '</h' + h.length + '>');
    // 4. Inline code, before bold/italic; content is already escaped, so no further esc
    s = s.replace(/`([^`\n]+)`/g, (_, c        ) => "<code>" + c + "</code>");
    // 5. Bold / italic
    s = s.replace(/\*\*([^*\n]+)\*\*/g, (_, c        ) => "<strong>" + c + "</strong>");
    s = s.replace(/\*([^*\n]+)\*/g, (_, c        ) => "<em>" + c + "</em>");
    // 6. Horizontal rule
    s = s.replace(/^-{3,}$/gm, "<hr>");
    // 7. Newlines to <br>; tables are already replaced and the code placeholders contain no \n, so this is safe
    s = s.replace(/\n/g, "<br>");
    // 8. Restore the code blocks
    s = s.replace(/\x00B(\d+)\x00/g, (_, i        ) => blocks[parseInt(i, 10)]);
    return s;
  }

  // rich and legacy stay callable on their own; with no CDN libraries rich throws exactly as before and safe() handles the fallback.
  function rich(text        )         {
    const libs = ports.libs();
    if (!libs) throw new Error("marked/DOMPurify 未加载");
    return renderMarkdownRich(text, libs);
  }

  return { safe: renderMarkdownSafe, rich, legacy: renderMarkdownLegacy };
}

// Browser wiring (injected by tooling/l0/emit.mjs): binds the service to the existing window contract.
// The CDN libraries and the escape bridge are resolved per call, mirroring the old markdown.js
// rule of never capturing a reference up front — the scripts load when they load.
// Normalising the marked-highlight UMD shape (a bare function versus an exports object carrying
// `.markedHighlight`) belongs here too, so the service touches no window and asserts no types.
// Bridge names are spelled out with the `window.` prefix: the contract scan only counts that form.
(function () {
  if (window.__markdown) return;

  function resolveHighlight() {
    var raw = window.markedHighlight;
    if (!raw) return null;
    if (typeof raw === "function") return raw;
    if (raw.markedHighlight && typeof raw.markedHighlight === "function") return raw.markedHighlight;
    return null;
  }

  var ports = {
    libs: function () {
      if (typeof window === "undefined") return null;
      if (!window.marked || !window.DOMPurify) return null;
      return {
        marked: window.marked,
        domPurify: window.DOMPurify,
        hljs: window.hljs,
        highlight: resolveHighlight(),
      };
    },
    esc: function (text) { return window.escapeSvc.esc(text); },
  };

  var md = createMarkdown(ports);
  window.__markdown = {
    safe: md.safe,
    rich: md.rich,
    legacy: md.legacy,
  };
})();

globalThis.createMarkdown = createMarkdown;
})();
