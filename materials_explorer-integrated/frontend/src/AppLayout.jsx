/**
 * AppLayout.jsx
 * Global layout shell for Materials Explorer.
 *
 * Architecture:
 *  - Fixed sidebar (260px) with Magic-UI-style animated active indicator (Framer Motion layoutId)
 *  - Scrollable main content area where tab components render
 *  - GSAP fade-up stagger on mount for sidebar items
 *  - Cyan focus glow on nav hover, spring-driven active pill
 *
 * Dependencies:
 *   npm install framer-motion gsap react-router-dom
 *   Google Fonts: Inter + JetBrains Mono (add to index.html or CSS)
 */

import { useEffect, useRef } from "react";
import { NavLink, useLocation, Outlet } from "react-router-dom";
import { motion, AnimatePresence } from "framer-motion";
import { gsap } from "gsap";

// ─── Design tokens (mirrors the system prompt palette) ───────────────────────
const TOKENS = {
  bgPage:      "#09090B",   // Zinc 950 — OLED Tech base
  bgSidebar:   "#0F172A",   // Slate 900 — sidebar surface
  bgCard:      "#1E293B",   // Slate 800 — card surface
  border:      "rgba(148,163,184,0.12)",  // Slate 400 @ 12%
  borderHover: "rgba(148,163,184,0.22)",
  accent:      "#06B6D4",   // Cyan 500
  accentDim:   "rgba(6,182,212,0.10)",
  accentGlow:  "rgba(6,182,212,0.15)",
  textPrimary: "#F1F5F9",   // Slate 100
  textMuted:   "#64748B",   // Slate 500
  textLabel:   "#94A3B8",   // Slate 400
};

// ─── Navigation config ────────────────────────────────────────────────────────
const NAV_ITEMS = [
  {
    id:    "semantic-search",
    path:  "/semantic-search",
    label: "Semantic Search",
    icon:  SemanticSearchIcon,
    tag:   "NLP",
  },
  {
    id:    "recommendations",
    path:  "/recommendations",
    label: "Recommendations",
    icon:  RecommendationsIcon,
    tag:   null,
  },
  {
    id:    "similar-materials",
    path:  "/similar-materials",
    label: "Similar Materials",
    icon:  SimilarMaterialsIcon,
    tag:   null,
  },
  {
    id:    "ml-predictions",
    path:  "/ml-predictions",
    label: "ML Predictions",
    icon:  MLPredictionsIcon,
    tag:   "ML",
  },
  {
    id:    "crystal-similarity",
    path:  "/crystal-similarity",
    label: "Crystal Similarity",
    icon:  CrystalSimilarityIcon,
    tag:   null,
  },
  {
    id:    "property-correlation",
    path:  "/property-correlation",
    label: "Property Correlation",
    icon:  PropertyCorrelationIcon,
    tag:   null,
  },
  {
    id:    "workspace",
    path:  "/workspace",
    label: "Workspace",
    icon:  WorkspaceIcon,
    tag:   null,
  },
];

// ─── SVG Icon Components ──────────────────────────────────────────────────────
// Thin-stroke (1.5px), 20×20 viewport, inheriting currentColor.

function SemanticSearchIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 20 20" fill="none" aria-hidden="true">
      <circle cx="8.5" cy="8.5" r="5.5" stroke="currentColor" strokeWidth="1.5"/>
      <path d="M14.5 14.5L18 18" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
      <path d="M6 8.5h5M8.5 6v5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round"/>
    </svg>
  );
}

function RecommendationsIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 20 20" fill="none" aria-hidden="true">
      <path d="M10 2l2.09 4.26L17 7.27l-3.5 3.41.83 4.82L10 13.25l-4.33 2.25.83-4.82L3 7.27l4.91-.71L10 2z"
        stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round"/>
    </svg>
  );
}

function SimilarMaterialsIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 20 20" fill="none" aria-hidden="true">
      <circle cx="6"  cy="10" r="3.5" stroke="currentColor" strokeWidth="1.5"/>
      <circle cx="14" cy="10" r="3.5" stroke="currentColor" strokeWidth="1.5"/>
      <path d="M9.5 10h1" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
    </svg>
  );
}

function MLPredictionsIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 20 20" fill="none" aria-hidden="true">
      <rect x="2" y="14" width="3" height="4" rx="0.8" stroke="currentColor" strokeWidth="1.5"/>
      <rect x="8.5" y="9"  width="3" height="9" rx="0.8" stroke="currentColor" strokeWidth="1.5"/>
      <rect x="15" y="4"   width="3" height="14" rx="0.8" stroke="currentColor" strokeWidth="1.5"/>
      <path d="M3.5 14L10 9l6 -5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeDasharray="2 2"/>
    </svg>
  );
}

function CrystalSimilarityIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 20 20" fill="none" aria-hidden="true">
      <polygon points="10,2 18,7 18,13 10,18 2,13 2,7"
        stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round"/>
      <polygon points="10,6 14,8.5 14,11.5 10,14 6,11.5 6,8.5"
        stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round"/>
      <circle cx="10" cy="10" r="1.5" fill="currentColor"/>
    </svg>
  );
}

function PropertyCorrelationIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 20 20" fill="none" aria-hidden="true">
      <circle cx="5"  cy="15" r="1.5" stroke="currentColor" strokeWidth="1.4"/>
      <circle cx="8"  cy="11" r="1.5" stroke="currentColor" strokeWidth="1.4"/>
      <circle cx="11" cy="8"  r="1.5" stroke="currentColor" strokeWidth="1.4"/>
      <circle cx="15" cy="5"  r="1.5" stroke="currentColor" strokeWidth="1.4"/>
      <path d="M3 17l14-14" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round" strokeDasharray="2 2.5"/>
    </svg>
  );
}

function WorkspaceIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 20 20" fill="none" aria-hidden="true">
      <rect x="2"  y="2"  width="7" height="7" rx="1.5" stroke="currentColor" strokeWidth="1.5"/>
      <rect x="11" y="2"  width="7" height="7" rx="1.5" stroke="currentColor" strokeWidth="1.5"/>
      <rect x="2"  y="11" width="7" height="7" rx="1.5" stroke="currentColor" strokeWidth="1.5"/>
      <rect x="11" y="11" width="7" height="7" rx="1.5" stroke="currentColor" strokeWidth="1.5"/>
    </svg>
  );
}

// ─── Logo mark ────────────────────────────────────────────────────────────────
function LogoMark() {
  return (
    <svg width="28" height="28" viewBox="0 0 28 28" fill="none" aria-hidden="true">
      <polygon
        points="14,2 25,8 25,20 14,26 3,20 3,8"
        stroke={TOKENS.accent}
        strokeWidth="1.5"
        strokeLinejoin="round"
        fill="none"
      />
      <polygon
        points="14,8 20,11.5 20,16.5 14,20 8,16.5 8,11.5"
        stroke={TOKENS.accent}
        strokeWidth="1.2"
        strokeLinejoin="round"
        fill={TOKENS.accentDim}
      />
      <circle cx="14" cy="14" r="2.5" fill={TOKENS.accent}/>
    </svg>
  );
}

// ─── SidebarNavItem ───────────────────────────────────────────────────────────
/**
 * Individual nav item.
 * When active, the shared layoutId="active-pill" animates the background pill
 * between items using Framer Motion's FLIP technique — this is the Magic UI
 * "sliding active indicator" pattern.
 */
function SidebarNavItem({ item, index }) {
  const location = useLocation();
  const isActive = location.pathname === item.path ||
    (location.pathname === "/" && index === 0);

  const Icon = item.icon;

  return (
    <NavLink
      to={item.path}
      style={{ textDecoration: "none", display: "block" }}
    >
      <motion.div
        initial={{ opacity: 0, x: -8 }}
        animate={{ opacity: 1, x: 0 }}
        transition={{ type: "spring", stiffness: 400, damping: 30, delay: 0.05 + index * 0.04 }}
        whileHover={{ x: isActive ? 0 : 2 }}
        style={{
          position:      "relative",
          display:       "flex",
          alignItems:    "center",
          gap:           "10px",
          padding:       "8px 10px",
          borderRadius:  "8px",
          cursor:        "pointer",
          marginBottom:  "2px",
          // Hover bg handled by CSS class below for performance
        }}
        className="nav-item"
      >
        {/* Animated background pill — shared layoutId slides between items */}
        {isActive && (
          <motion.div
            layoutId="active-pill"
            transition={{ type: "spring", stiffness: 380, damping: 34 }}
            style={{
              position:      "absolute",
              inset:         0,
              borderRadius:  "8px",
              background:    TOKENS.accentDim,
              border:        `1px solid ${TOKENS.accent}26`,
              zIndex:        0,
            }}
          />
        )}

        {/* Icon */}
        <span
          style={{
            position: "relative",
            zIndex:   1,
            display:  "flex",
            color:    isActive ? TOKENS.accent : TOKENS.textMuted,
            transition: "color 200ms ease",
            flexShrink: 0,
          }}
        >
          <Icon />
        </span>

        {/* Label */}
        <span
          style={{
            position:   "relative",
            zIndex:     1,
            fontFamily: "'Inter', 'Geist', system-ui, sans-serif",
            fontSize:   "13.5px",
            fontWeight: isActive ? 500 : 400,
            color:      isActive ? TOKENS.textPrimary : TOKENS.textLabel,
            letterSpacing: "0.01em",
            transition: "color 200ms ease",
            flex:       1,
            whiteSpace: "nowrap",
            overflow:   "hidden",
            textOverflow: "ellipsis",
          }}
        >
          {item.label}
        </span>

        {/* Optional badge tag (e.g. "NLP", "ML") */}
        {item.tag && (
          <span
            style={{
              position:    "relative",
              zIndex:      1,
              fontFamily:  "'JetBrains Mono', 'Geist Mono', monospace",
              fontSize:    "9.5px",
              fontWeight:  500,
              color:       isActive ? TOKENS.accent : TOKENS.textMuted,
              background:  isActive ? TOKENS.accentDim : "rgba(148,163,184,0.08)",
              border:      `1px solid ${isActive ? TOKENS.accent + "33" : "rgba(148,163,184,0.15)"}`,
              borderRadius: "4px",
              padding:     "1px 5px",
              letterSpacing: "0.05em",
              transition:  "all 200ms ease",
              flexShrink:  0,
            }}
          >
            {item.tag}
          </span>
        )}
      </motion.div>
    </NavLink>
  );
}

// ─── Sidebar ──────────────────────────────────────────────────────────────────
function Sidebar() {
  const navRef = useRef(null);

  // Nav items animate via Framer Motion (animate prop on each SidebarNavItem).
  // GSAP stagger removed — it conflicted with Framer Motion's opacity control.

  return (
    <aside
      style={{
        width:       "260px",
        minHeight:   "100vh",
        flexShrink:  0,
        background:  TOKENS.bgSidebar,
        borderRight: `1px solid ${TOKENS.border}`,
        display:     "flex",
        flexDirection: "column",
        position:    "sticky",
        top:         0,
        height:      "100vh",
        overflowY:   "auto",
        overflowX:   "hidden",
        zIndex:      20,
      }}
    >
      {/* ── Wordmark / Logo ── */}
      <div
        style={{
          padding:      "20px 16px 16px",
          borderBottom: `1px solid ${TOKENS.border}`,
          display:      "flex",
          alignItems:   "center",
          gap:          "10px",
        }}
      >
        <LogoMark />
        <div>
          <div
            style={{
              fontFamily:    "'Inter', 'Geist', system-ui, sans-serif",
              fontSize:      "14px",
              fontWeight:    600,
              color:         TOKENS.textPrimary,
              letterSpacing: "-0.01em",
            }}
          >
            Materials
          </div>
          <div
            style={{
              fontFamily:    "'JetBrains Mono', 'Geist Mono', monospace",
              fontSize:      "10px",
              fontWeight:    400,
              color:         TOKENS.accent,
              letterSpacing: "0.08em",
              marginTop:     "1px",
            }}
          >
            EXPLORER
          </div>
        </div>
      </div>

      {/* ── Nav section label ── */}
      <div style={{ padding: "16px 16px 6px" }}>
        <span
          style={{
            fontFamily:    "'Inter', system-ui, sans-serif",
            fontSize:      "10px",
            fontWeight:    500,
            color:         TOKENS.textMuted,
            letterSpacing: "0.1em",
            textTransform: "uppercase",
          }}
        >
          Tools
        </span>
      </div>

      {/* ── Nav items ── */}
      <nav
        ref={navRef}
        style={{ padding: "0 8px", flex: 1 }}
        aria-label="Main navigation"
      >
        {NAV_ITEMS.map((item, index) => (
          <SidebarNavItem key={item.id} item={item} index={index} />
        ))}
      </nav>

      {/* ── Footer status pill ── */}
      <div
        style={{
          padding:   "16px",
          borderTop: `1px solid ${TOKENS.border}`,
        }}
      >
        <div
          style={{
            display:      "flex",
            alignItems:   "center",
            gap:          "8px",
            background:   "rgba(6,182,212,0.06)",
            border:       `1px solid ${TOKENS.accent}22`,
            borderRadius: "8px",
            padding:      "8px 10px",
          }}
        >
          {/* Pulse dot */}
          <span style={{ position: "relative", display: "flex", flexShrink: 0 }}>
            <span
              className="pulse-ring"
              style={{
                width:        "8px",
                height:       "8px",
                borderRadius: "50%",
                background:   TOKENS.accent,
                display:      "block",
              }}
            />
          </span>
          <div>
            <div
              style={{
                fontFamily: "'JetBrains Mono', monospace",
                fontSize:   "10.5px",
                fontWeight: 500,
                color:      TOKENS.accent,
              }}
            >
              MP API
            </div>
            <div
              style={{
                fontFamily: "'Inter', system-ui, sans-serif",
                fontSize:   "10px",
                color:      TOKENS.textMuted,
                marginTop:  "1px",
              }}
            >
              Connected
            </div>
          </div>
        </div>
      </div>
    </aside>
  );
}

// ─── Content area ─────────────────────────────────────────────────────────────
/**
 * AnimatePresence wraps the Outlet so each tab fades-up when navigated to.
 * The key={pathname} forces remount on route change, triggering the animation.
 */
function ContentArea() {
  const location = useLocation();

  return (
    <main
      style={{
        flex:       1,
        minWidth:   0,
        minHeight:  "100vh",
        background: TOKENS.bgPage,
        overflowX:  "hidden",
        overflowY:  "auto",
        // Subtle vignette from the sidebar edge
        backgroundImage:
          "radial-gradient(ellipse 80% 60% at 10% 20%, rgba(6,182,212,0.03) 0%, transparent 70%)",
      }}
    >
      {/* Page-level fade-up transition */}
      <AnimatePresence mode="wait">
        <motion.div
          key={location.pathname}
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -6 }}
          transition={{
            duration: 0.25,
            ease:     [0.22, 1, 0.36, 1],   // custom ease-out-quint
          }}
          style={{ minHeight: "100%" }}
        >
          {/* Tab component renders here via React Router <Outlet> */}
          <Outlet />
        </motion.div>
      </AnimatePresence>
    </main>
  );
}

// ─── AppLayout (root export) ──────────────────────────────────────────────────
export default function AppLayout() {
  return (
    <>
      {/* Global base styles injected once */}
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600&family=JetBrains+Mono:wght@400;500&display=swap');

        *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

        html, body, #root {
          height: 100%;
          background: ${TOKENS.bgPage};
          color: ${TOKENS.textPrimary};
          font-family: 'Inter', 'Geist', system-ui, sans-serif;
          -webkit-font-smoothing: antialiased;
        }

        /* Sidebar scrollbar */
        aside::-webkit-scrollbar { width: 4px; }
        aside::-webkit-scrollbar-track { background: transparent; }
        aside::-webkit-scrollbar-thumb {
          background: rgba(148,163,184,0.15);
          border-radius: 4px;
        }

        /* Nav item hover bg — done in CSS for performance (no JS re-render) */
        .nav-item:hover {
          background: rgba(148,163,184,0.05);
        }

        /* Active item hover override — don't flicker the pill */
        .active .nav-item:hover {
          background: transparent;
        }

        /* Pulse animation for the status dot */
        @keyframes pulse-glow {
          0%, 100% { box-shadow: 0 0 0 0 rgba(6,182,212,0.45); }
          50%       { box-shadow: 0 0 0 5px rgba(6,182,212,0); }
        }
        .pulse-ring {
          animation: pulse-glow 2.4s ease-in-out infinite;
        }

        /* Monospace for all data/formula text (utility class) */
        .mono {
          font-family: 'JetBrains Mono', 'Geist Mono', monospace;
          font-size: 0.85em;
        }

        /* Thin horizontal rule */
        .divider {
          height: 1px;
          background: ${TOKENS.border};
          border: none;
          margin: 0;
        }
      `}</style>

      <div style={{ display: "flex", minHeight: "100vh" }}>
        <Sidebar />
        <ContentArea />
      </div>
    </>
  );
}

/**
 * ─── Usage with React Router ──────────────────────────────────────────────────
 *
 * In main.jsx / App.jsx:
 *
 *   import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";
 *   import AppLayout from "./AppLayout";
 *   import SemanticSearch      from "./tabs/SemanticSearch";
 *   import Recommendations     from "./tabs/Recommendations";
 *   import SimilarMaterials    from "./tabs/SimilarMaterials";
 *   import MLPredictions       from "./tabs/MLPredictions";
 *   import CrystalSimilarity   from "./tabs/CrystalSimilarity";
 *   import PropertyCorrelation from "./tabs/PropertyCorrelation";
 *   import Workspace           from "./tabs/Workspace";
 *
 *   export default function App() {
 *     return (
 *       <BrowserRouter>
 *         <Routes>
 *           <Route path="/" element={<AppLayout />}>
 *             <Route index element={<Navigate to="/semantic-search" replace />} />
 *             <Route path="semantic-search"      element={<SemanticSearch />} />
 *             <Route path="recommendations"      element={<Recommendations />} />
 *             <Route path="similar-materials"    element={<SimilarMaterials />} />
 *             <Route path="ml-predictions"       element={<MLPredictions />} />
 *             <Route path="crystal-similarity"   element={<CrystalSimilarity />} />
 *             <Route path="property-correlation" element={<PropertyCorrelation />} />
 *             <Route path="workspace"            element={<Workspace />} />
 *           </Route>
 *         </Routes>
 *       </BrowserRouter>
 *     );
 *   }
 *
 * ─── Shared design tokens (re-export for tab components) ─────────────────────
 *
 *   Export TOKENS from this file so every tab consumes the same palette:
 *   export { TOKENS };
 *
 * ─── Shared CSS class utilities for tab components ───────────────────────────
 *
 *   .mono        → JetBrains Mono; use on formulas, IDs, numeric values
 *   .divider     → 1px horizontal rule in border color
 *   .pulse-ring  → animated cyan glow dot
 */
