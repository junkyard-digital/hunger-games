import { BrowserRouter, Route, Routes } from 'react-router-dom';
import Home from './pages/Home';
import Join from './pages/Join';
import Play from './pages/Play';
import GmAuth from './pages/GmAuth';
import GmHome from './pages/GmHome';
import GmCreate from './pages/GmCreate';
import GmGame from './pages/GmGame';
import Watch from './pages/Watch';
import Replay from './pages/Replay';

export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<Home />} />
        <Route path="/join/:code" element={<Join />} />
        <Route path="/play/:gameId" element={<Play />} />
        <Route path="/gm" element={<GmHome />} />
        <Route path="/gm/login" element={<GmAuth />} />
        <Route path="/gm/new" element={<GmCreate />} />
        <Route path="/gm/game/:gameId" element={<GmGame />} />
        <Route path="/watch/:token" element={<Watch />} />
        <Route path="/replay/:gameId" element={<Replay />} />
        <Route path="*" element={<Home />} />
      </Routes>
    </BrowserRouter>
  );
}
