import { useCallback, useEffect, useState } from 'react';
import { Navigate, Route, Routes } from 'react-router-dom';
import UploadPage from './pages/UploadPage';
import ComposePage from './pages/ComposePage';
import DashboardPage from './pages/DashboardPage';
import LoginPage from './pages/LoginPage';
import { fetchJson } from './lib/api';
import { clearSession, readStoredSession, saveSession } from './lib/session';

function ProtectedRoute({ isAuthenticated, children }) {
  if (!isAuthenticated) {
    return <Navigate to="/login" replace />;
  }

  return children;
}

export default function App() {
  const [flow, setFlow] = useState({
    excelFile: null,
    preview: null
  });
  const [session, setSession] = useState(() => readStoredSession());
  const [authReady, setAuthReady] = useState(false);

  const validateSession = useCallback(async () => {
    const stored = readStoredSession();
    if (!stored) {
      setSession(null);
      setAuthReady(true);
      return;
    }

    try {
      const me = await fetchJson('/api/app-auth/me');
      const nextSession = {
        ...stored,
        user: me.user
      };
      saveSession(nextSession);
      setSession(nextSession);
    } catch (_error) {
      clearSession();
      setSession(null);
    } finally {
      setAuthReady(true);
    }
  }, []);

  useEffect(() => {
    validateSession();
  }, [validateSession]);

  function handleRecipientsReady(excelFile, preview) {
    setFlow({ excelFile, preview });
  }

  function handleLogin(nextSession) {
    saveSession(nextSession);
    setSession(nextSession);
    setAuthReady(true);
  }

  const handleLogout = useCallback(async () => {
    try {
      await fetchJson('/api/app-auth/logout', {
        method: 'POST'
      });
    } catch (_error) {
      // logout should still clear local state even if API call fails
    } finally {
      clearSession();
      setSession(null);
      setFlow({ excelFile: null, preview: null });
    }
  }, []);

  if (!authReady) {
    return <div className="auth-loading">Checking login session...</div>;
  }

  const isAuthenticated = Boolean(session?.token && session?.user?.email);

  return (
    <Routes>
      <Route path="/" element={<Navigate to={isAuthenticated ? '/dashboard' : '/login'} replace />} />
      <Route path="/login" element={isAuthenticated ? <Navigate to="/dashboard" replace /> : <LoginPage onLogin={handleLogin} />} />
      <Route
        path="/schedule"
        element={<Navigate to={isAuthenticated ? '/upload' : '/login'} replace />}
      />
      <Route
        path="/upload"
        element={
          <ProtectedRoute isAuthenticated={isAuthenticated}>
            <UploadPage flow={flow} onRecipientsReady={handleRecipientsReady} appUser={session?.user || null} onLogout={handleLogout} />
          </ProtectedRoute>
        }
      />
      <Route
        path="/compose"
        element={
          <ProtectedRoute isAuthenticated={isAuthenticated}>
            <ComposePage flow={flow} onRecipientsReady={handleRecipientsReady} appUser={session?.user || null} onLogout={handleLogout} />
          </ProtectedRoute>
        }
      />
      <Route
        path="/dashboard"
        element={
          <ProtectedRoute isAuthenticated={isAuthenticated}>
            <DashboardPage appUser={session?.user || null} onLogout={handleLogout} />
          </ProtectedRoute>
        }
      />
      <Route path="*" element={<Navigate to={isAuthenticated ? '/dashboard' : '/login'} replace />} />
    </Routes>
  );
}
