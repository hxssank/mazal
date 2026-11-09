import { Component, type ErrorInfo, type ReactNode } from 'react';

interface Props {
  children: ReactNode;
  onClose?: () => void;
}

export default class ErrorBoundary extends Component<Props, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('Mazal could not render a page.', error, info.componentStack);
  }

  render() {
    if (this.state.failed) {
      return <section className="loading-panel" role="alert">
        <h2>{this.props.onClose ? 'This form could not be displayed' : 'This page could not be displayed'}</h2>
        <p>Try opening it again. If it still fails, reload Mazal.</p>
        <button type="button" className="button primary" autoFocus={!!this.props.onClose} onClick={() => this.setState({ failed: false })}>Try again</button>
        {this.props.onClose && <button type="button" className="button secondary" onClick={this.props.onClose}>Close form</button>}
        <button type="button" className="button secondary" onClick={() => window.location.reload()}>Reload Mazal</button>
      </section>;
    }
    return this.props.children;
  }
}
