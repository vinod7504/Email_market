import { useState } from 'react';
import { Navigate, Route, Routes } from 'react-router-dom';
import UploadPage from './pages/UploadPage';
import ComposePage from './pages/ComposePage';
import DashboardPage from './pages/DashboardPage';

export default function App() {
  const [flow, setFlow] = useState({
    excelFile: null,
    preview: null
  });

  function handleRecipientsReady(excelFile, preview) {
    setFlow({ excelFile, preview });
  }

  return (
    <Routes>
      <Route path="/" element={<Navigate to="/upload" replace />} />
      <Route path="/schedule" element={<Navigate to="/upload" replace />} />
      <Route path="/upload" element={<UploadPage flow={flow} onRecipientsReady={handleRecipientsReady} />} />
      <Route path="/compose" element={<ComposePage flow={flow} onRecipientsReady={handleRecipientsReady} />} />
      <Route path="/dashboard" element={<DashboardPage />} />
    </Routes>
  );
}
