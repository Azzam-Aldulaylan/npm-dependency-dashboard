import { createRoot } from 'react-dom/client';

import './styles.css';
import { App } from './App.js';

const container = document.getElementById('root');
if (container === null) throw new Error('webview HTML is missing its #root element');

createRoot(container).render(<App />);
