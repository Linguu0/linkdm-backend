const fs = require('fs');

// 1. Update frontend FlowCanvas.jsx
let frontend = fs.readFileSync('../linkdm-frontend/src/components/FlowBuilder/FlowCanvas.jsx', 'utf8');
const quickRepliesJSX = `
      <div className="fb-quick-replies" style={{ marginTop: '12px' }}>
        <div style={{ fontSize: '13px', fontWeight: '500', color: '#9ca3af', marginBottom: '8px' }}>Quick Replies (Buttons)</div>
        {(step.quickReplies || []).map((qr, idx) => (
          <div key={idx} style={{ display: 'flex', gap: '8px', marginBottom: '8px' }}>
            <input
              type="text"
              placeholder="Button text (e.g. Send Link)"
              className="form-input"
              style={{ flex: 1, padding: '6px 12px', fontSize: '13px' }}
              value={qr.text}
              onChange={(e) => {
                const newQr = [...(step.quickReplies || [])];
                newQr[idx].text = e.target.value;
                onUpdate({ ...step, quickReplies: newQr });
              }}
            />
            <button
              onClick={() => {
                const newQr = [...(step.quickReplies || [])];
                newQr.splice(idx, 1);
                onUpdate({ ...step, quickReplies: newQr });
              }}
              style={{ background: 'none', border: 'none', color: '#ef4444', cursor: 'pointer', fontSize: '14px' }}
            >✕</button>
          </div>
        ))}
        {!(step.quickReplies && step.quickReplies.length >= 3) && (
          <button
            onClick={() => {
              const newQr = [...(step.quickReplies || []), { text: '' }];
              onUpdate({ ...step, quickReplies: newQr });
            }}
            style={{ background: 'rgba(255,255,255,0.05)', border: '1px dashed rgba(255,255,255,0.2)', color: '#a78bfa', padding: '6px 12px', borderRadius: '4px', fontSize: '13px', cursor: 'pointer', width: '100%', marginTop: '4px' }}
          >
            + Add Quick Reply
          </button>
        )}
      </div>
`;
frontend = frontend.replace(
  '<div className="fb-char-count">{(step.text || \'\').length} / 1000</div>\n    </div>',
  '<div className="fb-char-count">{(step.text || \'\').length} / 1000</div>' + quickRepliesJSX + '\n    </div>'
);
fs.writeFileSync('../linkdm-frontend/src/components/FlowBuilder/FlowCanvas.jsx', frontend);

// 2. Update backend flowRunner.js
let backend = fs.readFileSync('src/services/flowRunner.js', 'utf8');

backend = backend.replace(
  "type: firstMessage.type === 'button_message' ? 'button_template' : (firstMessage.messageType || 'text_message'),",
  "type: firstMessage.type === 'button_message' ? 'button_template' : (firstMessage.quickReplies && firstMessage.quickReplies.length > 0 ? 'quick_replies' : 'text_message'),"
);
backend = backend.replace(
  "buttonTemplateData: firstMessage.slides",
  "buttonTemplateData: firstMessage.slides,\n      quickRepliesData: firstMessage.quickReplies"
);

// Do the same for currentStep in CASE 2
backend = backend.replace(
  "type: currentStep.type === 'button_message' ? 'button_template' : (currentStep.messageType || 'text_message'),",
  "type: currentStep.type === 'button_message' ? 'button_template' : (currentStep.quickReplies && currentStep.quickReplies.length > 0 ? 'quick_replies' : 'text_message'),"
);
backend = backend.replace(
  "buttonTemplateData: currentStep.slides",
  "buttonTemplateData: currentStep.slides,\n      quickRepliesData: currentStep.quickReplies"
);

fs.writeFileSync('src/services/flowRunner.js', backend);
