import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { AuthProvider, useAuth } from './lib/auth';
import { SocketProvider } from './lib/socket';
import { CartProvider } from './lib/cart';
import { CallProvider } from './call/CallProvider';
import Layout from './components/Layout';
import Login, { homeFor } from './pages/Login';
import Register from './pages/Register';
import Restaurants from './pages/customer/Restaurants';
import Menu from './pages/customer/Menu';
import Cart from './pages/customer/Cart';
import Orders from './pages/customer/Orders';
import OrderTrack from './pages/customer/OrderTrack';
import AgentHome from './pages/agent/AgentHome';
import AgentOrder from './pages/agent/AgentOrder';
import AdminDashboard from './pages/admin/AdminDashboard';
import Account from './pages/Account';

function Guard({ role, children }) {
  const { user } = useAuth();
  if (!user) return <Navigate to="/login" replace />;
  if (role && user.role !== role) return <Navigate to={homeFor(user.role)} replace />;
  return children;
}

function AppRoutes() {
  const { user, loading } = useAuth();
  if (loading) return <div className="splash"><img src="/favicon.svg" alt="" width="56" height="56" /></div>;
  return (
    <Routes>
      <Route path="/login" element={user ? <Navigate to={homeFor(user.role)} replace /> : <Login />} />
      <Route path="/register" element={user ? <Navigate to={homeFor(user.role)} replace /> : <Register />} />
      <Route element={<Guard><Layout /></Guard>}>
        <Route path="/" element={<Guard role="customer"><Restaurants /></Guard>} />
        <Route path="/r/:id" element={<Guard role="customer"><Menu /></Guard>} />
        <Route path="/cart" element={<Guard role="customer"><Cart /></Guard>} />
        <Route path="/orders" element={<Guard role="customer"><Orders /></Guard>} />
        <Route path="/orders/:id" element={<Guard role="customer"><OrderTrack /></Guard>} />
        <Route path="/agent" element={<Guard role="agent"><AgentHome /></Guard>} />
        <Route path="/agent/orders/:id" element={<Guard role="agent"><AgentOrder /></Guard>} />
        <Route path="/admin" element={<Guard role="admin"><AdminDashboard /></Guard>} />
        <Route path="/account" element={<Account />} />
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}

export default function App() {
  return (
    <BrowserRouter>
      <AuthProvider>
        <SocketProvider>
          <CartProvider>
            <CallProvider>
              <AppRoutes />
            </CallProvider>
          </CartProvider>
        </SocketProvider>
      </AuthProvider>
    </BrowserRouter>
  );
}