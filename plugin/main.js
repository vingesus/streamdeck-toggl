/* eslint-disable no-unused-vars, no-undef */
const togglBaseUrl = 'https://www.toggl.com/api/v8'
const clockifyBaseUrl = 'https://api.clockify.me/api/v1';

let websocket = null
let currentButtons = new Map()
let polling = false

function connectElgatoStreamDeckSocket(inPort, inPluginUUID, inRegisterEvent, inInfo) {

  // Open the web socket (use 127.0.0.1 vs localhost because windows is "slow" resolving 'localhost')
  websocket = new WebSocket('ws://127.0.0.1:' + inPort)

  websocket.onopen = function () {
    // WebSocket is connected, register the plugin
    websocket.send(JSON.stringify(json = {
      event: inRegisterEvent,
      uuid: inPluginUUID
    }))
  }

  websocket.onmessage = function (evt) {
    // Received message from Stream Deck
    const jsonObj = JSON.parse(evt.data)

    const { event, context, payload } = jsonObj
    switch (event) {
      case 'keyDown':
        !payload.settings.apiToken && showAlert(context)
        !payload.settings.workspaceId && showAlert(context)
        toggle(context, payload.settings)
        break
      case 'willAppear':
        !payload.settings.apiToken && showAlert(context)
        !payload.isInMultiAction && payload.settings.apiToken && addButton(context, payload.settings)
        break
      case 'willDisappear':
        !payload.isInMultiAction && removeButton(context)
        break
      case 'didReceiveSettings': // anything could have changed, pull it, add it, and refresh.
        !payload.isInMultiAction && removeButton(context) && payload.settings.apiToken && addButton(context, payload.settings)
        !payload.isInMultiAction && refreshButtons()
        break
    }
  }
}


function removeButton(context) {
  currentButtons.delete(context)
}

function addButton(context, settings) {
  currentButtons.set(context, settings)
  initPolling()
}

// Polling
async function initPolling() {
  if (polling) return

  polling = true

  while (currentButtons.size > 0) { // eslint-disable-line no-unmodified-loop-condition
    refreshButtons()

    //nothing special about 5s, just a random choice
    await new Promise(r => setTimeout(r, 5000));
  }

  polling = false
}

function refreshButtons() {
  //Get the list of unique apiTokens
  var tokens = new Set([...currentButtons.values()].map(s => { return { apiToken: s.apiToken, userId: s.userId, workspaceId: s.workspaceId } }))

  tokens.forEach(token => {

    //Get the current entry for this token
    getCurrentEntry(token.apiToken, token.userId, token.workspaceId).then(entryData => {

      //Loop over all the buttons and update as appropriate
      currentButtons.forEach((settings, context) => {
        if (token.apiToken != settings.apiToken) //not one of "our" buttons
          return //We're in a forEach, this is effectively a 'continue'

        if (entryData //Does button match the active timer? 
          && entryData.workspaceId == settings.workspaceId
          && entryData.projectId == settings.projectId
          && entryData.description == settings.activity) {
          setState(context, 0)
          setTitle(context, `${formatElapsed(entryData.timeInterval.start)}\n\n\n${settings.label}`)
        } else { //if not, make sure it's 'off'
          setState(context, 1)
          setTitle(context, settings.label)
        }
      })
    })
  })
}

function formatElapsed(startTime) {
  const elapsed = Math.floor(Date.now() / 1000) - (Math.floor(new Date(startTime) / 1000));
  return formatSeconds(elapsed)
}

function formatSeconds(seconds) {
  if (seconds < 3600)
    return leadingZero(Math.floor(seconds / 60)) + ':' + leadingZero(seconds % 60)

  return leadingZero(Math.floor(seconds / 3600)) + ':' + formatSeconds(seconds % 3600)
}

function leadingZero(val) {
  if (val < 10)
    return '0' + val
  return val
}

async function toggle(context, settings) {
  const { apiToken, userId, promptToggle, activity, projectId, workspaceId, billableToggle } = settings

  getCurrentEntry(apiToken, userId, workspaceId).then(async entryData => {
    if (!entryData) {
      //Not running? Start a new one
      startEntry(apiToken, activity, workspaceId, projectId, billableToggle).then(v => refreshButtons())
    } else if (entryData.workspaceId == workspaceId && entryData.projectId == projectId && entryData.description == activity) {
      //The one running is "this one" -- toggle to stop

      //Check if prompt for updated entryname
      if (promptToggle) {
        entryData.description = prompt("Hvad har du arbejdet på?");
        entryData.start = entryData.timeInterval.start;
        await updateEntry(apiToken, entryData.workspaceId, entryData.id, entryData);
      }
      stopEntry(apiToken, entryData.workspaceId, entryData.userId).then(v => refreshButtons())
    } else {
      //Just start the new one, old one will stop, it's toggl.
      startEntry(apiToken, activity, workspaceId, projectId, billableToggle).then(v => refreshButtons())
    }
  })
}

// Toggl API Helpers

function updateEntry(apiToken = isRequired(), workspaceId = isRequired(), entryId = isRequired(), update = {}) {
  return fetch(
    `${clockifyBaseUrl}/workspaces/${workspaceId}/time-entries/${entryId}`, {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json',
      "X-Api-Key": apiToken
    },
    body: JSON.stringify(update)
  })
}

function startEntry(apiToken = isRequired(), activity = '', workspaceId = isRequired(), projectId = null, billableToggle = false) {
  return fetch(
    `${clockifyBaseUrl}/workspaces/${workspaceId}/time-entries/`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      "X-Api-Key": apiToken
    },
    body: JSON.stringify({
      start: new Date(),
      description: activity,
      projectId: projectId,
      billable: billableToggle
    })
  })
}

function stopEntry(apiToken = isRequired(), workspaceId = isRequired(), userId = isRequired()) {
  return fetch(
    `${clockifyBaseUrl}/workspaces/${workspaceId}/user/${userId}/time-entries/`, {
    method: 'PATCH',
    headers: {
      'Content-Type': 'application/json',
      "X-Api-Key": apiToken
    },
    body: JSON.stringify({
      end: new Date()
    })
  })
}

async function getCurrentEntry(apiToken = isRequired(), userId = isRequired(), workspaceId = isRequired()) {
  const response = await fetch(
    `${clockifyBaseUrl}/workspaces/${workspaceId}/user/${userId}/time-entries?in-progress=true`, {
    method: 'GET',
    headers: {
      "X-Api-Key": apiToken
    }
  })
  const data = await response.json()
  return data[0]
}

// Set Button State (for Polling)
function setState(context = isRequired(), state = isRequired()) {
  websocket && (websocket.readyState === 1) &&
    websocket.send(JSON.stringify({
      event: 'setState',
      context: context,
      payload: {
        state: state
      }
    }))
}

// Set Button Title (for Polling)
function setTitle(context = isRequired(), title = '') {
  websocket && (websocket.readyState === 1) && websocket.send(JSON.stringify({
    event: 'setTitle',
    context: context,
    payload: {
      title: title
    }
  }))
}

function showAlert(context = isRequired()) {
  websocket && (websocket.readyState === 1) &&
    websocket.send(JSON.stringify({
      event: 'showAlert',
      context: context
    }))
}

// throw error when required argument is not supplied
const isRequired = () => {
  throw new Error('Missing required params')
}

