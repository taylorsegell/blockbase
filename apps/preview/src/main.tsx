import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { ThemeProvider } from '@/components/theme-provider';
import { App } from './App';
import './index.css';
import './styles/themes/index.css';

function Root() {
  return (
    <StrictMode>
      <ThemeProvider>
        <App />
      </ThemeProvider>
    </StrictMode>
  );
}

createRoot(document.getElementById('root')!).render(<Root />);
