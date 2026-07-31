import { Component, type ErrorInfo, type ReactNode } from "react";

interface Props {
  children: ReactNode;
}

interface State {
  error?: Error;
}

/**
 * Renders the failure instead of a blank canvas. Without this a thrown render
 * error unmounts the whole tree and leaves only a stack trace in the console.
 */
export class ErrorBoundary extends Component<Props, State> {
  state: State = {};

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("Unhandled error", error, info.componentStack);
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    return (
      <div className="opener">
        <div className="opener-card">
          <h1>Something went wrong</h1>
          <p className="lede">The viewer hit an unexpected error.</p>
          <div className="error">{error.message}</div>
          <p style={{ marginTop: 18 }}>
            <button className="primary" onClick={() => this.setState({ error: undefined })}>
              Try again
            </button>
          </p>
        </div>
      </div>
    );
  }
}
