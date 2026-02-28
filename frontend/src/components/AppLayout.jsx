import { NavLink } from 'react-router-dom';

function navClassName({ isActive }) {
  return `nav-link${isActive ? ' active' : ''}`;
}

export default function AppLayout({ caption, children }) {
  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <span className="brand-dot" />
          MailPilot
        </div>

        <nav className="nav">
          <NavLink className={navClassName} to="/upload">
            Upload Recipients
          </NavLink>
          <NavLink className={navClassName} to="/compose">
            Template & Send
          </NavLink>
          <NavLink className={navClassName} to="/dashboard">
            Tracking Dashboard
          </NavLink>
        </nav>

        <p className="sidebar-caption">{caption}</p>
      </aside>

      <main className="content">{children}</main>
    </div>
  );
}
