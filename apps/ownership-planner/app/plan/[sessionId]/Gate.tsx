// Shared treatment for the states where there is no plan to show. Expiry and
// a bad link are ordinary events, not errors, so they read like it.

export default function Gate({ title, body }: { title: string; body: string }) {
  return (
    <div className="app">
      <header className="header">
        <div className="logo">
          <span className="mountains">⌃⌃</span>
          <div>
            <b>ALL SEASONS</b>
            <small>POWERSPORTS &amp; EQUIPMENT</small>
          </div>
        </div>
        <div className="tag">
          PEOPLE.
          <br />
          PLACES.
          <br />
          POSSIBILITIES.
        </div>
        <nav />
        <div className="experience">
          A BETTER
          <br />
          OWNERSHIP
          <br />
          EXPERIENCE
          <i />
        </div>
      </header>
      <div className="gate">
        <div className="gate-card">
          <h1>{title}</h1>
          <p>{body}</p>
        </div>
      </div>
    </div>
  );
}
