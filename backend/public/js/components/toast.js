// Toast notification component

export function showToast(message, type = 'info', duration = 4000) {
    const container = document.getElementById('toast-container');
    const toast = document.createElement('div');
    toast.className = `toast toast-${type}`;
    toast.innerHTML = `
        <span>${message}</span>
        <button class="toast-close">&times;</button>
    `;

    const remove = () => toast.remove();
    toast.querySelector('.toast-close').addEventListener('click', remove);
    container.appendChild(toast);

    if (duration > 0) {
        setTimeout(remove, duration);
    }
}
