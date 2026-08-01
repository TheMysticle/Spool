(function() {
  let uploadModalHTML = `
    <div class="modal-overlay" id="upload-modal-overlay">
      <div class="modal" id="upload-modal">
        <div class="modal-header">
          <h3 id="upload-modal-title">Upload Videos</h3>
          <button class="icon-btn" id="upload-modal-close" title="Close" type="button">
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>
          </button>
        </div>
        <div class="modal-body" id="upload-modal-body">
          <!-- Dynamically filled -->
        </div>
      </div>
    </div>
  `;

  let uploadProgressHTML = `
    <div id="upload-progress-container" class="upload-progress-container"></div>
  `;

  document.addEventListener('DOMContentLoaded', () => {
    document.body.insertAdjacentHTML('beforeend', uploadModalHTML);
    document.body.insertAdjacentHTML('beforeend', uploadProgressHTML);

    const trigger = document.getElementById('upload-trigger');
    if (trigger) {
      trigger.addEventListener('click', openUploadFlow);
    }
    
    document.getElementById('upload-modal-close').addEventListener('click', closeUploadModal);
    document.getElementById('upload-modal-overlay').addEventListener('click', (e) => {
      if (e.target === e.currentTarget) closeUploadModal();
    });
  });

  function closeUploadModal() {
    document.getElementById('upload-modal-overlay').classList.remove('open');
  }

  async function openUploadFlow() {
    const user = window.getUser ? window.getUser() : null;
    if (!user) return toast('You must be logged in to upload.', 'error');
    
    const isChannelRequired = user.role !== 'admin';
    
    // Check channel status
    try {
      const res = await api('/api/user/channel');
      if (isChannelRequired && !res.channel) {
        showChannelCreationForm();
      } else {
        showVideoUploadForm();
      }
      document.getElementById('upload-modal-overlay').classList.add('open');
    } catch (e) {
      toast('Error checking channel status.', 'error');
    }
  }

  function showChannelCreationForm() {
    document.getElementById('upload-modal-title').textContent = 'Create Your Channel';
    const body = document.getElementById('upload-modal-body');
    body.innerHTML = `
      <p style="margin-top:0; color:var(--text-secondary); margin-bottom:24px; font-size: 0.95rem;">You need to create a channel before you can upload videos.</p>
      
      <div style="display: flex; align-items: center; gap: 16px; margin-bottom: 24px;">
        <div class="avatar avatar-lg settings-avatar-preview" id="create-channel-avatar-preview" style="width: 64px; height: 64px; font-size: 1.5rem; display: flex; align-items: center; justify-content: center; background: var(--bg-surface); border: 1px dashed var(--border-subtle); color: var(--text-muted); cursor: pointer;">?</div>
        <div class="settings-avatar-actions">
          <input type="file" id="create-channel-avatar-input" hidden accept="image/jpeg,image/png,image/webp" />
          <button class="btn btn-ghost btn-sm" id="create-channel-avatar-upload" type="button">Upload Avatar</button>
        </div>
      </div>

      <div class="form-group" style="margin-bottom:24px;">
        <label class="form-label" for="create-channel-name">Channel Name</label>
        <input type="text" id="create-channel-name" class="form-input" placeholder="My Awesome Channel" />
      </div>
      
      <div class="modal-footer" style="margin-top:0; justify-content: flex-end;">
        <button class="btn btn-primary" id="create-channel-submit">Create Channel</button>
      </div>
    `;

    let imageBase64 = null;
    document.getElementById('create-channel-avatar-upload').addEventListener('click', () => {
      document.getElementById('create-channel-avatar-input').click();
    });
    document.getElementById('create-channel-avatar-preview').addEventListener('click', () => {
      document.getElementById('create-channel-avatar-input').click();
    });
    
    document.getElementById('create-channel-avatar-input').addEventListener('change', async (e) => {
      const file = e.target.files[0];
      if (!file) return;
      if (!file.type.startsWith('image/')) {
        return toast('Please select an image, not a video.', 'error');
      }
      try {
        imageBase64 = await fileToDataUrl(file);
        document.getElementById('create-channel-avatar-preview').innerHTML = `<img src="${imageBase64}" style="width:100%; height:100%; object-fit:cover; border-radius:50%;" />`;
      } catch (err) {
        toast('Failed to load image', 'error');
      }
    });

    document.getElementById('create-channel-submit').addEventListener('click', async () => {
      const name = document.getElementById('create-channel-name').value.trim();
      if (!name) return toast('Please enter a channel name.', 'error');
      try {
        await api('/api/user/channel', {
          method: 'POST',
          body: JSON.stringify({ name, imageBase64 })
        });
        toast('Channel created!', 'success');
        showVideoUploadForm();
      } catch (err) {
        toast(err.message || 'Failed to create channel', 'error');
      }
    });
  }

  function showVideoUploadForm() {
    document.getElementById('upload-modal-title').textContent = 'Upload Videos';
    const body = document.getElementById('upload-modal-body');
    body.innerHTML = `
      <div id="upload-dropzone" class="upload-dropzone">
        <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="margin-bottom: 12px; color: var(--accent);"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path><polyline points="17 8 12 3 7 8"></polyline><line x1="12" y1="3" x2="12" y2="15"></line></svg>
        <div style="font-weight:600; font-size:1.1rem; margin-bottom: 4px;">Drag and drop video files here</div>
        <div style="color:var(--text-secondary); font-size:0.9rem; margin-bottom: 16px;">MP4, WEBM, MKV, AVI, MOV up to 5GB</div>
        <input type="file" id="upload-file-input" hidden multiple accept="video/mp4,video/webm,video/x-matroska,video/quicktime,video/x-msvideo" />
        <button class="btn btn-primary" id="upload-browse-btn">Browse Files</button>
      </div>
    `;

    const dropzone = document.getElementById('upload-dropzone');
    const input = document.getElementById('upload-file-input');
    const browseBtn = document.getElementById('upload-browse-btn');

    browseBtn.addEventListener('click', () => input.click());

    dropzone.addEventListener('dragover', (e) => {
      e.preventDefault();
      dropzone.classList.add('dragover');
    });
    dropzone.addEventListener('dragleave', (e) => {
      e.preventDefault();
      dropzone.classList.remove('dragover');
    });
    dropzone.addEventListener('drop', (e) => {
      e.preventDefault();
      dropzone.classList.remove('dragover');
      if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
        handleFilesSelected(e.dataTransfer.files);
      }
    });
    input.addEventListener('change', (e) => {
      if (e.target.files && e.target.files.length > 0) {
        handleFilesSelected(e.target.files);
      }
    });
  }

  function handleFilesSelected(files) {
    const validFiles = Array.from(files).filter(f => f.type.startsWith('video/') || f.name.match(/\.(mp4|webm|mkv|mov|avi)$/i));
    if (validFiles.length === 0) return toast('No valid video files selected.', 'error');
    
    showConfigurationStep(validFiles);
  }

  function showConfigurationStep(files) {
    const modalBody = document.getElementById('upload-modal-body');
    const html = `
      <div class="upload-config-step">
        <h4 class="upload-config-title">Upload Settings (${files.length} video${files.length > 1 ? 's' : ''})</h4>
        
        <div class="upload-radio-group">
          <label class="upload-radio-label">
            <input type="radio" name="date-pref" value="modified" checked>
            Use Date Modified (Original file date)
          </label>
          <label class="upload-radio-label">
            <input type="radio" name="date-pref" value="filename">
            Parse from Filename (e.g. 20240101_video.mp4)
          </label>
          <label class="upload-radio-label">
            <input type="radio" name="date-pref" value="custom">
            Custom Date
          </label>
          
          <div class="upload-custom-date" id="upload-custom-date-container">
            <input type="date" id="upload-custom-date-input">
          </div>
          
          <div style="margin-top: 16px; border-top: 1px solid var(--border); padding-top: 12px;">
            <label class="upload-radio-label" style="display:flex; align-items:center; gap:8px;">
              <input type="checkbox" id="upload-is-vhs">
              <span style="font-weight: 500;">Tag as VHS</span>
              <span style="font-size: 0.8rem; color: var(--text-secondary); margin-left: auto;">(Hide from main feed)</span>
            </label>
          </div>
        </div>

        <div class="upload-config-actions">
          <button type="button" class="btn btn-secondary" onclick="document.getElementById('upload-modal-close').click()">Cancel</button>
          <button type="button" class="btn btn-primary" id="start-upload-btn">Start Upload</button>
        </div>
      </div>
    `;
    modalBody.innerHTML = html;

    const radios = document.querySelectorAll('input[name="date-pref"]');
    const customContainer = document.getElementById('upload-custom-date-container');
    
    radios.forEach(r => {
      r.addEventListener('change', (e) => {
        if (e.target.value === 'custom') {
          customContainer.classList.add('active');
        } else {
          customContainer.classList.remove('active');
        }
      });
    });

    document.getElementById('start-upload-btn').addEventListener('click', () => {
      const selectedPref = document.querySelector('input[name="date-pref"]:checked').value;
      const customDate = document.getElementById('upload-custom-date-input').value;
      
      if (selectedPref === 'custom' && !customDate) {
        return toast('Please select a custom date.', 'error');
      }

      const isVhs = document.getElementById('upload-is-vhs').checked;

      closeUploadModal();
      startUpload(files, selectedPref, customDate, isVhs);
    });
  }

  function startUpload(files, datePref, customDate, isVhs = false) {
    const token = localStorage.getItem('ma_token');

    files.forEach((file, index) => {
      const formData = new FormData();
      formData.append('datePref', datePref);
      if (datePref === 'custom') {
        formData.append('customDate', customDate);
      }
      formData.append('is_vhs', isVhs);

      const lastModifiedArray = [{ name: file.name, lastModified: file.lastModified }];
      formData.append('lastModifiedData', JSON.stringify(lastModifiedArray));

      formData.append('videos', file);

      const uploadId = 'upload_' + Date.now() + '_' + index;
      addProgressDialog(uploadId, `Uploading ${file.name}...`);
      
      const xhr = new XMLHttpRequest();
      xhr.open('POST', '/api/upload');
      if (token) xhr.setRequestHeader('Authorization', `Bearer ${token}`);
      
      xhr.upload.addEventListener('progress', (e) => {
        if (e.lengthComputable) {
          const percent = Math.round((e.loaded / e.total) * 100);
          updateProgressDialog(uploadId, percent, e.loaded, e.total, file.name);
        }
      });

      xhr.onload = () => {
        if (xhr.status >= 200 && xhr.status < 300) {
          let responseTitle = file.name;
          let videoId = null;
          try {
            const data = JSON.parse(xhr.responseText);
            if (data.videos && data.videos.length > 0) {
              responseTitle = data.videos[0].title;
              videoId = data.videos[0].id;
            }
          } catch(e) {}
          finishProgressDialog(uploadId, responseTitle, 'success', videoId, responseTitle);
        } else {
          let msg = 'Upload failed';
          try { msg = JSON.parse(xhr.responseText).error || msg; } catch(e){}
          finishProgressDialog(uploadId, msg, 'error');
        }
      };
      
      xhr.onerror = () => {
        finishProgressDialog(uploadId, 'Network error during upload', 'error');
      };

      // Store xhr so we can abort it if needed
      window[`${uploadId}_xhr`] = xhr;

      xhr.send(formData);
    });
  }

  function formatMb(bytes) {
    if (!bytes) return '0 MB';
    const mb = bytes / (1024 * 1024);
    if (mb >= 1024) return (mb / 1024).toFixed(2) + ' GB';
    return mb.toFixed(1) + ' MB';
  }

  function addProgressDialog(id, text) {
    const container = document.getElementById('upload-progress-container');
    const html = `
      <div class="upload-progress-card" id="${id}" data-video-id="">
        <div class="upload-progress-header">
          <span class="upload-progress-title" id="${id}-title" title="${escHtml(text)}">${text}</span>
          <span class="upload-progress-percent" id="${id}-percent" style="font-size:0.8rem;color:var(--text-secondary);margin-left:auto;padding-right:8px;white-space:nowrap;">0%</span>
          <div class="upload-progress-actions">
            <button class="upload-progress-edit icon-btn btn-sm" id="${id}-edit" title="Edit Video" style="display:none;" onclick="toggleUploadEdit('${id}')">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 20h9"></path><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"></path></svg>
            </button>
            <button class="upload-progress-cancel icon-btn btn-sm" id="${id}-cancel" title="Cancel/Delete" onclick="cancelUpload('${id}')">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>
            </button>
          </div>
        </div>
        <div class="upload-progress-bar-container" id="${id}-bar-container">
          <div class="upload-progress-bar" id="${id}-bar" style="width:0%"></div>
        </div>
        <div class="upload-progress-edit-form" id="${id}-edit-form" style="display:none;">
          <input type="text" id="${id}-edit-title" class="form-input" placeholder="Video Title" style="margin-bottom: 8px;">
          <textarea id="${id}-edit-desc" class="form-input" placeholder="Description" rows="2" style="margin-bottom: 8px;"></textarea>
          <div style="display:flex; justify-content:flex-end; gap:8px; margin-top:4px;">
            <button class="btn btn-secondary btn-sm" onclick="toggleUploadEdit('${id}')">Cancel</button>
            <button class="btn btn-primary btn-sm" onclick="saveUploadEdit('${id}')">Save</button>
          </div>
        </div>
      </div>
    `;
    container.insertAdjacentHTML('beforeend', html);
  }

  function updateProgressDialog(id, percent, loaded = 0, total = 0, fileName = '') {
    const bar = document.getElementById(`${id}-bar`);
    const percentEl = document.getElementById(`${id}-percent`);
    const titleEl = document.getElementById(`${id}-title`);

    if (bar) bar.style.width = `${percent}%`;

    if (percentEl) {
      if (percent < 100) {
        percentEl.textContent = `${percent}% (${formatMb(loaded)} / ${formatMb(total)})`;
      } else {
        percentEl.textContent = `Processing on server…`;
        if (titleEl && fileName) {
          titleEl.textContent = `Saving ${fileName}…`;
        }
      }
    }
  }

  function finishProgressDialog(id, msg, type, videoId = null, responseTitle = '') {
    const card = document.getElementById(id);
    if (!card) return;
    
    if (videoId) card.dataset.videoId = videoId;
    
    const title = document.getElementById(`${id}-title`);
    title.textContent = msg;
    if (type === 'error') title.style.color = 'var(--danger)';
    if (type === 'success') {
      title.style.color = 'var(--success)';
      const editBtn = document.getElementById(`${id}-edit`);
      if (editBtn) editBtn.style.display = 'inline-flex';
      
      const barContainer = document.getElementById(`${id}-bar-container`);
      if (barContainer) barContainer.style.display = 'none';

      const titleInput = document.getElementById(`${id}-edit-title`);
      if (titleInput) titleInput.value = responseTitle;
    }

    // Set a 30 second timeout instead of 3 seconds
    card.timeoutId = setTimeout(() => {
      card.style.opacity = '0';
      setTimeout(() => card.remove(), 300);
    }, 30000);
  }

  window.toggleUploadEdit = function(id) {
    const form = document.getElementById(`${id}-edit-form`);
    if (!form) return;
    const card = document.getElementById(id);
    if (card && card.timeoutId) {
      clearTimeout(card.timeoutId); // stop the auto-hide if they start editing
    }

    if (form.style.display === 'none') {
      form.style.display = 'block';
    } else {
      form.style.display = 'none';
    }
  };

  window.saveUploadEdit = async function(id) {
    const card = document.getElementById(id);
    const videoId = card.dataset.videoId;
    if (!videoId) return;

    const title = document.getElementById(`${id}-edit-title`).value;
    const description = document.getElementById(`${id}-edit-desc`).value;

    try {
      const res = await fetch(`/api/videos/${videoId}`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${localStorage.getItem('ma_token')}`
        },
        body: JSON.stringify({ title, description })
      });
      if (!res.ok) throw new Error('Failed to update');
      
      const titleEl = document.getElementById(`${id}-title`);
      if (titleEl) titleEl.textContent = title;
      
      toast('Video updated successfully', 'success');
      toggleUploadEdit(id);
    } catch (e) {
      toast('Error updating video', 'error');
    }
  };

  window.cancelUpload = async function(id) {
    const card = document.getElementById(id);
    const videoId = card ? card.dataset.videoId : null;

    if (window[`${id}_xhr`]) {
      window[`${id}_xhr`].abort();
      delete window[`${id}_xhr`];
      if (card) card.remove();
      toast('Upload cancelled', 'error');
    } else if (videoId) {
      if (!confirm('Are you sure you want to delete this uploaded video?')) return;
      try {
        const res = await fetch(`/api/videos/${videoId}`, {
          method: 'DELETE',
          headers: {
            'Authorization': `Bearer ${localStorage.getItem('ma_token')}`
          }
        });
        if (res.ok) {
          if (card) card.remove();
          toast('Video deleted', 'success');
        } else {
          toast('Error deleting video', 'error');
        }
      } catch (e) {
        toast('Error deleting video', 'error');
      }
    } else {
      if (card) card.remove();
    }
  };

  // Utility copy from shared.js for avatar preview
  function fileToDataUrl(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result || ''));
      reader.onerror = () => reject(new Error('Failed to read image file.'));
      reader.readAsDataURL(file);
    });
  }

})();
