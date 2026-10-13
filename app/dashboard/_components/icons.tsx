// 18px stroke icons (currentColor). Decorative: always aria-hidden.
const P = { width: 18, height: 18, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 1.8, strokeLinecap: "round" as const, strokeLinejoin: "round" as const, "aria-hidden": true, focusable: false };

export const Icon = {
  overview: () => (
    <svg {...P}><path d="M3 10.5 12 3l9 7.5" /><path d="M5 9.5V21h14V9.5" /><path d="M10 21v-6h4v6" /></svg>
  ),
  fleet: () => (
    <svg {...P}><circle cx="12" cy="5" r="2.2" /><circle cx="5" cy="19" r="2.2" /><circle cx="19" cy="19" r="2.2" /><path d="M12 7.2v4.3M12 11.5 6.5 17M12 11.5l5.5 5.5" /></svg>
  ),
  tasks: () => (
    <svg {...P}><path d="M9 6h11M9 12h11M9 18h11" /><path d="M4 6h.01M4 12h.01M4 18h.01" strokeWidth={2.6} /></svg>
  ),
  approvals: () => (
    <svg {...P}><circle cx="12" cy="12" r="9" /><path d="m8 12.3 2.7 2.7L16 9.6" /></svg>
  ),
  memory: () => (
    <svg {...P}><ellipse cx="12" cy="5.5" rx="8" ry="2.8" /><path d="M4 5.5v6.5c0 1.5 3.6 2.8 8 2.8s8-1.3 8-2.8V5.5" /><path d="M4 12v6.5c0 1.5 3.6 2.8 8 2.8s8-1.3 8-2.8V12" /></svg>
  ),
  devices: () => (
    <svg {...P}><rect x="4" y="5" width="16" height="11" rx="1.5" /><path d="M2 19h20" /></svg>
  ),
  access: () => (
    <svg {...P}><rect x="5" y="10.5" width="14" height="10" rx="1.5" /><path d="M8 10.5V7.5a4 4 0 0 1 8 0v3" /><path d="M12 14.5v2.5" /></svg>
  ),
  power: () => (
    <svg {...P}><path d="M12 3v8" /><path d="M6.4 6.6a8 8 0 1 0 11.2 0" /></svg>
  ),
  signOut: () => (
    <svg {...P}><path d="M15 4h3.5A1.5 1.5 0 0 1 20 5.5v13a1.5 1.5 0 0 1-1.5 1.5H15" /><path d="M10 16.5 14.5 12 10 7.5" /><path d="M14.5 12H4" /></svg>
  ),
};
