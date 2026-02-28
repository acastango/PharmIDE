import React from 'react';
import ReactDOM from 'react-dom/client';
import PharmIDE from './PharmIDE';

document.documentElement.style.cssText = 'margin:0;padding:0;height:100%;overflow:hidden';
document.body.style.cssText = 'margin:0;padding:0;height:100%;overflow:hidden';
document.getElementById('root').style.cssText = 'width:100%;height:100%;overflow:hidden';

const link = document.createElement('link');
link.rel = 'stylesheet';
link.href = 'https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500;600;700;800&family=IBM+Plex+Sans:wght@300;400;500;600;700;800&display=swap';
document.head.appendChild(link);

ReactDOM.createRoot(document.getElementById('root')).render(<PharmIDE />); import React from 'react';
import ReactDOM from 'react-dom/client';
import PharmIDE from './PharmIDE';

document.documentElement.style.cssText = 'margin:0;padding:0;height:100%;overflow:hidden';
document.body.style.cssText = 'margin:0;padding:0;height:100%;overflow:hidden';
document.getElementById('root').style.cssText = 'width:100%;height:100%;overflow:hidden';

const link = document.createElement('link');
link.rel = 'stylesheet';
link.href = 'https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500;600;700;800&family=IBM+Plex+Sans:wght@300;400;500;600;700;800&display=swap';
document.head.appendChild(link);

ReactDOM.createRoot(document.getElementById('root')).render(<PharmIDE />);