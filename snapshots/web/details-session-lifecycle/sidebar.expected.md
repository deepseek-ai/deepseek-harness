# Recorded-session Sidebar states

## A normal: two panes

```json
{
  "viewport": [
    1680,
    1000
  ],
  "columns": [
    280,
    644,
    756
  ],
  "columnTransition": "grid-template-columns",
  "expanded": true,
  "mode": "push",
  "panelContentWidth": 756,
  "panelOuterWidth": 757,
  "coversViewport": false,
  "resizeHandleWidth": 8,
  "expandedDirectories": [],
  "panes": [
    {
      "active": true,
      "tabs": [
        {
          "title": "Files",
          "selected": true
        },
        {
          "title": "Start",
          "selected": false
        }
      ]
    },
    {
      "active": false,
      "tabs": [
        {
          "title": "Files",
          "selected": true
        }
      ]
    }
  ]
}
```

## A manual fullscreen: underlying columns retained

```json
{
  "viewport": [
    1680,
    1000
  ],
  "columns": [
    280,
    644,
    756
  ],
  "columnTransition": "none",
  "expanded": true,
  "mode": "fullscreen",
  "panelContentWidth": 1680,
  "panelOuterWidth": 1680,
  "coversViewport": true,
  "resizeHandleWidth": 0,
  "expandedDirectories": [],
  "panes": [
    {
      "active": true,
      "tabs": [
        {
          "title": "Files",
          "selected": true
        },
        {
          "title": "Start",
          "selected": false
        }
      ]
    },
    {
      "active": false,
      "tabs": [
        {
          "title": "Files",
          "selected": true
        }
      ]
    }
  ]
}
```

## A closed with manual fullscreen retained

```json
{
  "viewport": [
    1680,
    1000
  ],
  "columns": [
    280,
    1400,
    0
  ],
  "columnTransition": "none",
  "expanded": false,
  "mode": "fullscreen",
  "panelContentWidth": 0,
  "panelOuterWidth": 0,
  "coversViewport": false,
  "resizeHandleWidth": 0,
  "expandedDirectories": [],
  "panes": [
    {
      "active": true,
      "tabs": [
        {
          "title": "Files",
          "selected": true
        },
        {
          "title": "Start",
          "selected": false
        }
      ]
    },
    {
      "active": false,
      "tabs": [
        {
          "title": "Files",
          "selected": true
        }
      ]
    }
  ]
}
```

## B closed: independent pane and expanded workspace directory

```json
{
  "viewport": [
    1680,
    1000
  ],
  "columns": [
    280,
    1400,
    0
  ],
  "columnTransition": "grid-template-columns",
  "expanded": false,
  "mode": "push",
  "panelContentWidth": 0,
  "panelOuterWidth": 0,
  "coversViewport": false,
  "resizeHandleWidth": 0,
  "expandedDirectories": [
    "workspace"
  ],
  "panes": [
    {
      "active": true,
      "tabs": [
        {
          "title": "Files",
          "selected": true
        }
      ]
    }
  ]
}
```

## A restored: manual fullscreen, tabs, and panes

```json
{
  "viewport": [
    1680,
    1000
  ],
  "columns": [
    280,
    644,
    756
  ],
  "columnTransition": "none",
  "expanded": true,
  "mode": "fullscreen",
  "panelContentWidth": 1680,
  "panelOuterWidth": 1680,
  "coversViewport": true,
  "resizeHandleWidth": 0,
  "expandedDirectories": [],
  "panes": [
    {
      "active": true,
      "tabs": [
        {
          "title": "Files",
          "selected": true
        },
        {
          "title": "Start",
          "selected": false
        }
      ]
    },
    {
      "active": false,
      "tabs": [
        {
          "title": "Files",
          "selected": true
        }
      ]
    }
  ]
}
```

## B restored: normal mode and Files directory state

```json
{
  "viewport": [
    1680,
    1000
  ],
  "columns": [
    280,
    644,
    756
  ],
  "columnTransition": "grid-template-columns",
  "expanded": true,
  "mode": "push",
  "panelContentWidth": 756,
  "panelOuterWidth": 757,
  "coversViewport": false,
  "resizeHandleWidth": 8,
  "expandedDirectories": [
    "workspace"
  ],
  "panes": [
    {
      "active": true,
      "tabs": [
        {
          "title": "Files",
          "selected": true
        }
      ]
    }
  ]
}
```

## A restored: expanded normal panel

```json
{
  "viewport": [
    1680,
    1000
  ],
  "columns": [
    280,
    644,
    756
  ],
  "columnTransition": "grid-template-columns",
  "expanded": true,
  "mode": "push",
  "panelContentWidth": 756,
  "panelOuterWidth": 757,
  "coversViewport": false,
  "resizeHandleWidth": 8,
  "expandedDirectories": [],
  "panes": [
    {
      "active": true,
      "tabs": [
        {
          "title": "Files",
          "selected": true
        },
        {
          "title": "Start",
          "selected": false
        }
      ]
    },
    {
      "active": false,
      "tabs": [
        {
          "title": "Files",
          "selected": true
        }
      ]
    }
  ]
}
```

## A capacity-closed: wide left preference protected

```json
{
  "viewport": [
    1024,
    1000
  ],
  "columns": [
    420,
    604,
    0
  ],
  "columnTransition": "grid-template-columns",
  "expanded": false,
  "mode": "push",
  "panelContentWidth": 0,
  "panelOuterWidth": 0,
  "coversViewport": false,
  "resizeHandleWidth": 0,
  "expandedDirectories": [],
  "panes": [
    {
      "active": true,
      "tabs": [
        {
          "title": "Files",
          "selected": true
        },
        {
          "title": "Start",
          "selected": false
        }
      ]
    },
    {
      "active": false,
      "tabs": [
        {
          "title": "Files",
          "selected": true
        }
      ]
    }
  ]
}
```

## A widened: remains closed

```json
{
  "viewport": [
    1680,
    1000
  ],
  "columns": [
    420,
    1260,
    0
  ],
  "columnTransition": "grid-template-columns",
  "expanded": false,
  "mode": "push",
  "panelContentWidth": 0,
  "panelOuterWidth": 0,
  "coversViewport": false,
  "resizeHandleWidth": 0,
  "expandedDirectories": [],
  "panes": [
    {
      "active": true,
      "tabs": [
        {
          "title": "Files",
          "selected": true
        },
        {
          "title": "Start",
          "selected": false
        }
      ]
    },
    {
      "active": false,
      "tabs": [
        {
          "title": "Files",
          "selected": true
        }
      ]
    }
  ]
}
```

## A automatic fullscreen at 767px

```json
{
  "viewport": [
    767,
    1000
  ],
  "columns": [
    56,
    711,
    0
  ],
  "columnTransition": "none",
  "expanded": true,
  "mode": "fullscreen",
  "panelContentWidth": 767,
  "panelOuterWidth": 767,
  "coversViewport": true,
  "resizeHandleWidth": 0,
  "expandedDirectories": [],
  "panes": [
    {
      "active": true,
      "tabs": [
        {
          "title": "Files",
          "selected": true
        },
        {
          "title": "Start",
          "selected": false
        }
      ]
    },
    {
      "active": false,
      "tabs": [
        {
          "title": "Files",
          "selected": true
        }
      ]
    }
  ]
}
```

## A automatic fullscreen exited: widening does not reopen

```json
{
  "viewport": [
    1680,
    1000
  ],
  "columns": [
    420,
    1260,
    0
  ],
  "columnTransition": "grid-template-columns",
  "expanded": false,
  "mode": "push",
  "panelContentWidth": 0,
  "panelOuterWidth": 0,
  "coversViewport": false,
  "resizeHandleWidth": 0,
  "expandedDirectories": [],
  "panes": [
    {
      "active": true,
      "tabs": [
        {
          "title": "Files",
          "selected": true
        },
        {
          "title": "Start",
          "selected": false
        }
      ]
    },
    {
      "active": false,
      "tabs": [
        {
          "title": "Files",
          "selected": true
        }
      ]
    }
  ]
}
```
