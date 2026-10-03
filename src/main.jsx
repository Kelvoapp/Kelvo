import React from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Link, Route, Routes, useLocation } from 'react-router-dom';
import '@fontsource-variable/fraunces/full.css';
import '@fontsource-variable/fraunces/full-italic.css';
import '@fontsource-variable/martian-mono/standard.css';
import './tokens.css';
import './base.css';
import './keys.css';
import Tuner from './chrome/Tuner';
import Home from './home/Home';
import HeatBoard from './heat/HeatBoard';
import Token from './token/Token';
import Agent from './agent/Agent';
import ColdGate from './cold/ColdGate';
import Kelvo from './pages/Kelvo';
import Docs from './pages/Docs';
const Cold = React.lazy(() => import('./cold/Cold'));
const Launch = React.lazy(() => import('./launch/Launch'));

function NotFound() {
  return <main style={{ minHeight: '100svh', display: 'grid', placeItems: 'center', textAlign: 'center', padding: 24 }}>
    <div style={{ display: 'grid', gap: 18, justifyItems: 'center' }}><h1 style={{ fontSize: 52 }}>This reads <em>0 K</em></h1><p style={{ color: 'var(--kv-mute)' }}>Nothing moves at this address.</p><Link className="kv-key" to="/"><span>Back to the bloom</span></Link></div>
  </main>;
}
function Shell() {
  const loc = useLocation();
  React.useEffect(() => { if (!loc.hash) scrollTo(0, 0); }, [loc.pathname, loc.hash]);
  return <>
    <Tuner />
    <Routes>
      <Route path="/" element={<Home />} />
      <Route path="/heat" element={<HeatBoard />} />
      <Route path="/token/:address" element={<Token />} />
      <Route path="/agent" element={<Agent />} />
      <Route path="/cold" element={<ColdGate><React.Suspense fallback={<main className="kv-cold" role="status" />}><Cold /></React.Suspense></ColdGate>} />
      <Route path="/launch" element={<React.Suspense fallback={<main className="kv-page" role="status" />}><Launch /></React.Suspense>} />
      <Route path="/kelvo" element={<Kelvo />} />
      <Route path="/docs" element={<Docs />} />
      <Route path="*" element={<NotFound />} />
    </Routes>
  </>;
}
createRoot(document.getElementById('root')).render(<React.StrictMode><BrowserRouter><Shell /></BrowserRouter></React.StrictMode>);
