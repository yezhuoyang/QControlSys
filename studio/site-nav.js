// The menu bar of QuantumOS. Load it with <script type="module" src="/site-nav.js"> and
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
      ["IBM Quantum Manila · native pulse debugger", "/course/M1#step-through-the-published-commands"],
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
      ["Quantinuum H2 · published phase scan", "/course/M3"],
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
    runs: [["Lukin group · entanglement transport", "/course/M2"], ["ZAC 14-qubit program on a zoned array", "/riscq-studio?example=neutral-bv14"]],
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
  background:#fff;border-bottom:1px solid #dde1ea;font:14px "Inter","Segoe UI",Arial,sans-serif;color:#111827;box-sizing:border-box;min-width:0}
.qn *{box-sizing:border-box}
.qn-brand{display:flex;align-items:center;gap:6px;font-weight:700;color:#111827;text-decoration:none;white-space:nowrap;margin-right:14px}
.qn-brand i{width:13px;height:13px;border-radius:3px;background:url("/quantumos.svg") center / cover no-repeat;display:inline-block}
.qn-brand span{font-weight:400;color:#4338ca}
.qn-links{display:flex;align-items:stretch;gap:2px;height:100%;overflow-x:auto;scrollbar-width:none;min-width:0}
.qn-links::-webkit-scrollbar{display:none}
.qn-links>a,.qn-links>button{display:flex;align-items:center;padding:0 9px;color:#3b4456;text-decoration:none;white-space:nowrap;
  border:0;border-bottom:2px solid transparent;background:none;font:inherit;font-size:13.5px;cursor:pointer;border-radius:0}
.qn-links>a:hover,.qn-links>button:hover{color:#4338ca}
.qn-links>a[aria-current="page"]{color:#111827;border-bottom-color:#4338ca;font-weight:600}
.qn-links>button[aria-expanded="true"]{color:#4338ca;border-bottom-color:#22b8cf}
.qn :focus-visible{outline:2px solid #4338ca;outline-offset:-2px}
.qn-menu{position:absolute;top:37px;left:14px;width:min(860px,calc(100vw - 28px));display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:10px;
  padding:12px;background:#fff;border:1px solid #dde1ea;border-radius:10px;box-shadow:0 10px 30px #0002}
.qn-menu[hidden]{display:none}
.qn-plat{border:1px solid #e6e9f2;border-radius:8px;padding:10px 11px;font-size:13px;line-height:1.4}
.qn-plat h3{margin:0 0 3px;font-size:14px}
.qn-plat h3 a{color:#111827;text-decoration:none}
.qn-plat h3 a:hover{color:#4338ca}
.qn-plat p{margin:0 0 6px;color:#586174}
.qn-plat b{display:block;font:600 10.5px "Inter",sans-serif;letter-spacing:.07em;text-transform:uppercase;color:#586174;margin:6px 0 2px}
.qn-plat ul{list-style:none;margin:0;padding:0}
.qn-plat li a{display:block;padding:2px 4px;margin:0 -4px;border-radius:4px;color:#1e1b4b;text-decoration:none}
.qn-plat li a:hover,.qn-plat li a:focus-visible{background:#eef0fe;color:#4338ca}
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
  const nav = element("nav", { class: "qn", "aria-label": "QuantumOS" });
  const brand = element("a", { class: "qn-brand", href: "/", ...(here === "/" ? { "aria-current": "page" } : {}) }, element("i", { "aria-hidden": "true" }), element("b", {}, "QuantumOS"));
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
      const background = here === "/course/background" || here.startsWith("/course/background/");
      if (here === href || (href === "/course" && here.startsWith("/course/") && !background) || (href === "/learn" && background))
        a.setAttribute("aria-current", "page");
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
