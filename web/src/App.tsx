import { lazy, Suspense } from 'react';
import { Navigate, Route, Routes } from 'react-router-dom';
import { useAuth } from './auth';
import Layout from './components/Layout';
import { Loading } from './components/ui';
import { ForgotPage, LoginPage, ResetPage } from './pages/Auth';

const Dashboard = lazy(() => import('./pages/Dashboard'));
const Conversations = lazy(() => import('./pages/Conversations'));
const Leads = lazy(() => import('./pages/Leads'));
const LeadProfile = lazy(() => import('./pages/LeadProfile'));
const Duplicates = lazy(() => import('./pages/Duplicates'));
const Pipeline = lazy(() => import('./pages/Pipeline'));
const Agenda = lazy(() => import('./pages/Agenda'));
const Catalog = lazy(() => import('./pages/Catalog'));
const Reports = lazy(() => import('./pages/Reports'));
const Automations = lazy(() => import('./pages/Automations'));
const Integrations = lazy(() => import('./pages/Integrations'));
const Admin = lazy(() => import('./pages/Admin'));
const Profile = lazy(() => import('./pages/Profile'));

function Guard({ children, manager, admin }: { children: JSX.Element; manager?: boolean; admin?: boolean }) {
  const { isManager, isAdmin } = useAuth();
  if ((admin && !isAdmin) || (manager && !isManager)) return <Navigate to="/" replace />;
  return children;
}

export default function App() {
  const { user, loading } = useAuth();
  if (loading) return <Loading text="Iniciando..." />;
  if (!user) {
    return (
      <Routes>
        <Route path="/esqueci-senha" element={<ForgotPage />} />
        <Route path="/redefinir-senha" element={<ResetPage />} />
        <Route path="*" element={<LoginPage />} />
      </Routes>
    );
  }
  return (
    <Layout>
      <Suspense fallback={<Loading />}>
        <Routes>
          <Route path="/" element={<Dashboard />} />
          <Route path="/conversas" element={<Conversations />} />
          <Route path="/conversas/:id" element={<Conversations />} />
          <Route path="/leads" element={<Leads />} />
          <Route path="/leads/duplicados" element={<Guard manager><Duplicates /></Guard>} />
          <Route path="/leads/:id" element={<LeadProfile />} />
          <Route path="/funil" element={<Pipeline />} />
          <Route path="/agenda" element={<Agenda />} />
          <Route path="/catalogo" element={<Catalog />} />
          <Route path="/relatorios" element={<Reports />} />
          <Route path="/automacoes" element={<Guard manager><Automations /></Guard>} />
          <Route path="/integracoes" element={<Guard manager><Integrations /></Guard>} />
          <Route path="/admin" element={<Guard manager><Admin /></Guard>} />
          <Route path="/admin/:tab" element={<Guard manager><Admin /></Guard>} />
          <Route path="/perfil" element={<Profile />} />
          <Route path="/redefinir-senha" element={<Navigate to="/perfil" replace />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </Suspense>
    </Layout>
  );
}
