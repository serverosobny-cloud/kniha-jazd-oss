// Pagination component

export function renderPagination(total, limit, offset, onChange) {
    const totalPages = Math.ceil(total / limit);
    const currentPage = Math.floor(offset / limit) + 1;

    if (totalPages <= 1) return '';

    let html = '<div class="pagination">';

    html += `<button ${currentPage === 1 ? 'disabled' : ''} data-page="${currentPage - 1}">&laquo;</button>`;

    const startPage = Math.max(1, currentPage - 2);
    const endPage = Math.min(totalPages, currentPage + 2);

    if (startPage > 1) {
        html += `<button data-page="1">1</button>`;
        if (startPage > 2) html += `<span class="pagination-info">...</span>`;
    }

    for (let i = startPage; i <= endPage; i++) {
        html += `<button data-page="${i}" class="${i === currentPage ? 'active' : ''}">${i}</button>`;
    }

    if (endPage < totalPages) {
        if (endPage < totalPages - 1) html += `<span class="pagination-info">...</span>`;
        html += `<button data-page="${totalPages}">${totalPages}</button>`;
    }

    html += `<button ${currentPage === totalPages ? 'disabled' : ''} data-page="${currentPage + 1}">&raquo;</button>`;
    html += `<span class="pagination-info">${total} záznamov</span>`;
    html += '</div>';

    // Attach event after rendering
    setTimeout(() => {
        document.querySelectorAll('.pagination button[data-page]').forEach(btn => {
            btn.addEventListener('click', () => {
                const page = parseInt(btn.dataset.page);
                if (page >= 1 && page <= totalPages) {
                    onChange((page - 1) * limit);
                }
            });
        });
    }, 0);

    return html;
}
