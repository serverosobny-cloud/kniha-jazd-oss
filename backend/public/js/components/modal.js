// Modal component

export function showModal({ title, body, footer, large = false, onClose }) {
    closeModal();
    const root = document.getElementById('modal-root');

    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.innerHTML = `
        <div class="modal ${large ? 'modal-lg' : ''}">
            <div class="modal-header">
                <h3>${title}</h3>
                <button class="modal-close">&times;</button>
            </div>
            <div class="modal-body">${typeof body === 'string' ? body : ''}</div>
            ${footer ? `<div class="modal-footer">${footer}</div>` : ''}
        </div>
    `;

    if (typeof body !== 'string') {
        overlay.querySelector('.modal-body').innerHTML = '';
        overlay.querySelector('.modal-body').appendChild(body);
    }

    const close = () => {
        overlay.remove();
        if (onClose) onClose();
    };

    overlay.querySelector('.modal-close').addEventListener('click', close);
    overlay.addEventListener('click', (e) => {
        if (e.target === overlay) close();
    });

    root.appendChild(overlay);
    return { close, element: overlay };
}

export function closeModal() {
    const root = document.getElementById('modal-root');
    root.innerHTML = '';
}
