import { NavLink, Route, Routes } from "react-router-dom";
import { Mic } from "lucide-react";
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
            <Mic size={18} strokeWidth={2} />
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
