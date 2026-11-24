// The menu bar of QControl Studio. Load it with <script type="module" src="/site-nav.js"> and
// it inserts itself as the first child of <body>. It carries its own style, so a page needs no
// stylesheet for it, and it is a flex:0 0 auto block, so full-viewport pages whose body is a
// column flexbox keep their layout. The Platforms menu says, for each platform, where its
// hardware is designed and which runs show it.

const PLATFORMS = [
  {
    name: "Superconducting transmons",
    learn: "/learn#superconducting",
    how: "Microwave pulses on coax drive and read out each qubit.",
    design: [["Design editor", "/riscq-design"]],
    runs: [
      ["Bell pair with feed-forward", "/riscq-studio?example=superconducting-feedforward&outcome=c=1"],
      ["The ring as an editable design", "/riscq-studio?example=superconducting-design"],
      ["Repetition code with a decoder core", "/riscq-studio?example=superconducting-repetition&outcome=s0=1"],
    ],
  },
  {
    name: "Trapped-ion QCCD",
    learn: "/learn#trapped-ion",
    how: "Lasers address ions in gate zones; electrode voltages shuttle them between zones.",
    design: [["QCCD Studio design page ↗", "https://www.qccd.academy/studio.html#design"]],
    runs: [
      ["GHZ of three ions from OpenQASM", "/riscq-studio?example=qccd-ghz3&outcome=q0=1&outcome=q2=1"],
      ["Loop rotation on a Studio design", "/riscq-studio?example=qccd-rotation"],
      ["H2 replay, physical view", "/qccd-studio"],
    ],
  },
  {
    name: "Neutral atoms",
    learn: "/learn#neutral-atom",
    how: "Optical tweezers moved by AOD tones carry atoms; Rydberg and Raman lasers drive gates.",
    design: [["ZAC architecture file (no editor yet)", "/learn#e1"]],
    runs: [["ZAC 14-qubit program on a zoned array", "/riscq-studio?example=neutral-bv14"]],
  },
];

const LINKS = [
  ["Learn", "/course"],
  ["Background", "/learn"],
  ["Platforms", null],
  ["Design", "/riscq-design"],
  ["Workspace", "/riscq-studio"],
  ["Detailed debugger", "/riscq"],
  ["Machines", "/machines"],
  ["Validation", "/validation"],
];

const CSS = `
.qn{flex:0 0 auto;position:relative;z-index:1000;display:flex;align-items:center;gap:4px;height:38px;padding:0 14px;
  background:#fff;border-bottom:1px solid #d3ddda;font:14px "Inter","Segoe UI",Arial,sans-serif;color:#152b2d;box-sizing:border-box;min-width:0}
.qn *{box-sizing:border-box}
.qn-brand{display:flex;align-items:center;gap:6px;font-weight:700;color:#152b2d;text-decoration:none;white-space:nowrap;margin-right:14px}
.qn-brand i{width:13px;height:13px;border-radius:3px;background:linear-gradient(135deg,#00695d,#58b8ac);display:inline-block}
.qn-brand span{font-weight:400;color:#00695d}
.qn-links{display:flex;align-items:stretch;gap:2px;height:100%;overflow-x:auto;scrollbar-width:none;min-width:0}
.qn-links::-webkit-scrollbar{display:none}
.qn-links>a,.qn-links>button{display:flex;align-items:center;padding:0 9px;color:#3f5457;text-decoration:none;white-space:nowrap;
  border:0;border-bottom:2px solid transparent;background:none;font:inherit;font-size:13.5px;cursor:pointer;border-radius:0}
.qn-links>a:hover,.qn-links>button:hover{color:#00695d}
.qn-links>a[aria-current="page"]{color:#152b2d;border-bottom-color:#00695d;font-weight:600}
.qn-links>button[aria-expanded="true"]{color:#00695d;border-bottom-color:#58b8ac}
.qn :focus-visible{outline:2px solid #00695d;outline-offset:-2px}
.qn-menu{position:absolute;top:37px;left:14px;width:min(860px,calc(100vw - 28px));display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:10px;
  padding:12px;background:#fff;border:1px solid #d3ddda;border-radius:10px;box-shadow:0 10px 30px #0002}
.qn-menu[hidden]{display:none}
.qn-plat{border:1px solid #e3eae7;border-radius:8px;padding:10px 11px;font-size:13px;line-height:1.4}
.qn-plat h3{margin:0 0 3px;font-size:14px}
.qn-plat h3 a{color:#152b2d;text-decoration:none}
.qn-plat h3 a:hover{color:#00695d}
.qn-plat p{margin:0 0 6px;color:#5a6c6f}
.qn-plat b{display:block;font:600 10.5px "Inter",sans-serif;letter-spacing:.07em;text-transform:uppercase;color:#5a6c6f;margin:6px 0 2px}
.qn-plat ul{list-style:none;margin:0;padding:0}
.qn-plat li a{display:block;padding:2px 4px;margin:0 -4px;border-radius:4px;color:#1f3a5f;text-decoration:none}
.qn-plat li a:hover,.qn-plat li a:focus-visible{background:#e4f1ec;color:#00695d}
@media (max-width:760px){.qn{padding:0 8px}.qn-brand{margin-right:6px}.qn-brand b{display:none}
  .qn-menu{position:fixed;top:38px;left:6px;right:6px;width:auto;grid-template-columns:1fr;max-height:calc(100vh - 48px);overflow:auto}}
`;

function element(tag, attrs = {}, ...kids) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  node.append(...kids);
  return node;
}
const link = (text, href) => element("a", { href, ...(/^https?:/.test(href) ? { target: "_blank", rel: "noopener" } : {}) }, text);

function build() {
  if (document.querySelector("nav.qn")) return;
  if (!document.getElementById("qn-style")) document.head.append(element("style", { id: "qn-style" }, CSS));
  const here = location.pathname.replace(/\/$/, "") || "/";
  const nav = element("nav", { class: "qn", "aria-label": "QControl Studio" });
  const brand = element("a", { class: "qn-brand", href: "/", ...(here === "/" ? { "aria-current": "page" } : {}) }, element("i", { "aria-hidden": "true" }), element("b", {}, "QControl"), element("span", {}, "Studio"));
  const links = element("div", { class: "qn-links" });
  const menu = element("div", { class: "qn-menu", id: "qn-platforms", hidden: "" });
  for (const p of PLATFORMS) {
    const list = (items) => element("ul", {}, ...items.map(([t, h]) => element("li", {}, link(t, h))));
    menu.append(element("section", { class: "qn-plat" },
      element("h3", {}, link(p.name, p.learn)),
      element("p", {}, p.how),
      element("b", {}, "Design it"), list(p.design),
      element("b", {}, "Example runs"), list(p.runs)));
  }
  let toggle;
  for (const [text, href] of LINKS) {
    if (href) {
      const a = link(text, href);
      if (here === href || (href === "/course" && here.startsWith("/course/"))) a.setAttribute("aria-current", "page");
      links.append(a);
    } else {
      toggle = element("button", { type: "button", "aria-expanded": "false", "aria-controls": "qn-platforms" }, text + " ▾");
      links.append(toggle);
    }
  }
  nav.append(brand, links, menu);
  document.body.prepend(nav);

  const items = () => [...menu.querySelectorAll("a")];
  const open = (focusFirst) => {
    menu.hidden = false;
    toggle.setAttribute("aria-expanded", "true");
    const r = toggle.getBoundingClientRect();
    if (innerWidth > 760) menu.style.left = Math.max(14, Math.min(r.left, innerWidth - menu.offsetWidth - 14)) + "px";
    if (focusFirst) items()[0]?.focus();
  };
  const close = (refocus) => {
    if (menu.hidden) return;
    menu.hidden = true;
    toggle.setAttribute("aria-expanded", "false");
    if (refocus) toggle.focus();
  };
  toggle.addEventListener("click", () => (menu.hidden ? open(false) : close(false)));
  toggle.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown" || ((e.key === "Enter" || e.key === " ") && menu.hidden)) {
      e.preventDefault();
      open(true);
    }
  });
  menu.addEventListener("keydown", (e) => {
    const list = items(), k = list.indexOf(document.activeElement);
    if (e.key === "Escape") {
      e.preventDefault();
      close(true);
    } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      list[(k + (e.key === "ArrowDown" ? 1 : list.length - 1)) % list.length].focus();
    } else if (e.key === "Home" || e.key === "End") {
      e.preventDefault();
      list[e.key === "Home" ? 0 : list.length - 1].focus();
    }
  });
  menu.addEventListener("focusout", (e) => {
    if (!nav.contains(e.relatedTarget)) close(false);
  });
  document.addEventListener("pointerdown", (e) => {
    if (!nav.contains(e.target)) close(false);
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !menu.hidden) close(true);
  });
}

if (document.body) build();
else document.addEventListener("DOMContentLoaded", build);
