import { NavLink, Route, Routes } from "react-router-dom";
import Home from "./pages/Home";
import Enhance from "./pages/Enhance";
import Caption from "./pages/Caption";
import Toast from "./components/Toast";
import { useState } from "react";

function App() {
  const [toast, setToast] = useState(null);

  return (
    <div className="app-shell">
      <header className="top-nav">
        <NavLink to="/" className="logo-link">
          Voxora
          <span className="logo-mark" aria-hidden="true">
            <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <rect x="9" y="2" width="6" height="12" rx="3" />
              <path d="M5 10v2a7 7 0 0 0 14 0v-2" />
              <path d="M12 19v3" />
              <path d="M8 22h8" />
            </svg>
          </span>
        </NavLink>
        <nav className="nav-links">
          <NavLink
            to="/enhance"
            className={({ isActive }) => `nav-item ${isActive ? "active" : ""}`}
          >
            Enhance
          </NavLink>
          <NavLink
            to="/caption"
            className={({ isActive }) => `nav-item ${isActive ? "active" : ""}`}
          >
            Caption
          </NavLink>
        </nav>
      </header>

      <main>
        <Routes>
          <Route path="/" element={<Home />} />
          <Route path="/enhance" element={<Enhance setToast={setToast} />} />
          <Route path="/caption" element={<Caption setToast={setToast} />} />
        </Routes>
      </main>

      <Toast toast={toast} onClose={() => setToast(null)} />
    </div>
  );
}

export default App;
