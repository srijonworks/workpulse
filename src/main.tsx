import {createRoot} from 'react-dom/client';
import App from './App.tsx';
import {WidgetApp} from './components/widgets/WidgetApp.tsx';
import {ErrorBoundary, reportUnhandled, setErrorSink} from './components/ui/ErrorBoundary.tsx';
import {errorToLog} from './utils/health/clientLog';
import {getEngine} from './utils/storage';
import {localTimeStr} from './utils/dates';
import {installGlobalErrorHandlers} from './utils/health/reportError';
import './index.css';

// The desktop widget windows load this same page as /?widget=time or /?widget=tasks.
const widget = new URLSearchParams(window.location.search).get('widget');

// Nothing that goes wrong may pass unseen: errors no part of the page caught (a script error, a rejected promise,
// a crash in React) are reported to the health registry and the log, and a crash shows a plain screen with a Reload.
setErrorSink(errorToLog);
installGlobalErrorHandlers(window, reportUnhandled);

const savedNote = () => {
  const at = getEngine().status().lastOkAt;
  return at ? `Your data was last saved at ${localTimeStr(new Date(at))}.` : null;
};

createRoot(document.getElementById('root')!, {
  onUncaughtError: (error) => reportUnhandled('React', error),
}).render(
  widget === 'time' || widget === 'tasks' ? (
    <ErrorBoundary area="the widget" variant="widget">
      <WidgetApp kind={widget} />
    </ErrorBoundary>
  ) : (
    <ErrorBoundary area="WorkPulse" variant="root" onBeforeReload={() => getEngine().flushAll()} savedNote={savedNote}>
      <App />
    </ErrorBoundary>
  ),
);
