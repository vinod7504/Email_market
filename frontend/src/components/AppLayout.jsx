import { NavLink } from 'react-router-dom';

function navClassName({ isActive }) {
  return `nav-link${isActive ? ' active' : ''}`;
}

export default function AppLayout({ caption, children, user = null, onLogout = () => {} }) {
  const userLabel = user?.email || '';

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <span className="brand-dot" />
          MailPilot
        </div>

        <nav className="nav">
          <NavLink className={navClassName} to="/dashboard">
            Campaign Home
          </NavLink>
          <NavLink className={navClassName} to="/upload">
            Upload Recipients
          </NavLink>
          <NavLink className={navClassName} to="/compose">
            Template & Send
          </NavLink>
        </nav>

        <p className="sidebar-caption">{caption}</p>

        {user ? (
          <div className="sidebar-account">
            <div className="sidebar-account-email">{userLabel}</div>
            {user.username ? <div className="sidebar-account-username">@{user.username}</div> : null}
            <div className="sidebar-account-role">{user.isAdmin ? 'Admin Access' : 'User Access'}</div>
            <button className="btn btn-danger sidebar-logout" onClick={onLogout} type="button">
              Logout
            </button>
          </div>
        ) : null}
      </aside>

      <main className="content">{children}</main>
    </div>
  );
}
